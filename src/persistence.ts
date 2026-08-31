/**
 * src/persistence.ts — ouroboros state on disk (pure IO, no pi imports).
 *
 * Layout under the pi agent data dir (`~/.pi/agent` by default):
 *
 *   <dataDir>/ouroboros/rules.md            — self-learned rules, one per line
 *   <dataDir>/ouroboros/digests/<sid>.json  — pending session digests
 *   <dataDir>/skills/<name>/SKILL.md        — self-written skills (pi discovers
 *                                             these automatically at startup)
 *
 * All writes are atomic (temp + rename). All reads return empty state on
 * corrupt files. Ouroboros must never crash pi over a half-written file.
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import type { OuroborosDigest } from "./digest.ts";

export const DEFAULT_RULES_CAP = 50;
export const DEFAULT_RULES_MAX_CHARS = 3000;
export const DEFAULT_REFLECT_MIN_PROMPTS = 5;
export const MAX_RULE_CHARS = 500;
/** The appendRule cleaning window never grows past this (a pathological
 * multi-MB garbage prefix is not scanned in full). */
export const MAX_RULE_WINDOW = 16 * 1024;
/** Rules files over this size are not read (and never overwritten). */
export const MAX_RULES_FILE_BYTES = 1024 * 1024;
/** Rules files over this many lines are truncated at the read (the
 * default cap is 50 rules; 10k lines is a generous ceiling). A file
 * without a trailing newline keeps at most MAX_RULES_LINES+1 lines. */
export const MAX_RULES_LINES = 10_000;
/** Digest files over this size are not writer-produced (all fields are
 * capped): skip the read so a crafted multi-MB file never materializes. */
export const MAX_DIGEST_FILE_BYTES = 1024 * 1024;

/** Session ids are UUIDs; anything else is hashed before touching the fs. */
const SAFE_ID = /^[a-zA-Z0-9_-]+$/;

export function ouroborosDir(dataDir: string): string {
	return path.join(dataDir, "ouroboros");
}

export function rulesFile(dataDir: string): string {
	return path.join(ouroborosDir(dataDir), "rules.md");
}

export function digestsDir(dataDir: string): string {
	return path.join(ouroborosDir(dataDir), "digests");
}



/** Hash an unsafe session id into a distinct, collision-resistant fragment. */
function hashSessionId(sessionId: string): string {
	const h = createHash("sha256").update(sessionId).digest("hex").slice(0, 16);
	return `sid-h-${h}`;
}

/** Sanitize a session id into a safe filename fragment (hash fallback). */
export function safeSessionId(sessionId: string): string {
	// A sid-h-<16hex> id is already a hashed name — return it idempotently
	// so loadDigest/deleteDigest find the file that saveDigest wrote for a
	// dot-containing session id. (A verbatim session id with that exact
	// shape would collide with a hash, but pi generates UUIDv7 ids.)
	if (/^sid-h-[0-9a-f]{16}$/.test(sessionId)) return sessionId;
	if (SAFE_ID.test(sessionId) && !sessionId.includes("..")) return sessionId;
	return hashSessionId(sessionId);
}
/** The pre-round-5 djb2 hash scheme (git 3ac74e6): `sid-<base36>`.
 * Surviving pending digests from that era carry this filename; the
 * filename/sessionId consistency checks must accept it (FixAudit24). */
export function legacySessionId(sessionId: string): string {
	let h = 5381;
	for (let i = 0; i < sessionId.length; i++) h = ((h << 5) + h + sessionId.charCodeAt(i)) | 0;
	return `sid-${(h >>> 0).toString(36)}`;
}
/** True when a raw sessionId round-trips to the given filename fragment
 * under the current or the legacy hash scheme. */
export function sessionIdMatchesFile(raw: string, sid: string): boolean {
	return safeSessionId(raw) === sid || legacySessionId(raw) === sid;
}

export function digestFile(dataDir: string, sessionId: string): string {
	return path.join(digestsDir(dataDir), `${safeSessionId(sessionId)}.json`);
}

export function skillsDir(dataDir: string): string {
	return path.join(dataDir, "skills");
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

/** In-memory rules cache: rules are read every turn, so avoid re-reading. */
let rulesCache: { file: string; mtimeMs: number; size: number; rules: string[] } | null = null;
/** File path of the last known-missing rules file (negative cache). */
let rulesMissingFile: string | null = null;
/** The negative cache is time-bounded. An externally created rules.md is
 * picked up. */
let rulesMissingAt = 0;
/** Load rules as a list of non-empty lines (comments starting with `#` kept). */
export function loadRules(dataDir: string): string[] {
	// Never read through a symlinked ouroboros dir (same trust boundary
	// as every other ouroboros state path): the rules would come from
	// the target and be injected into the system prompt every turn
	// (RuntimeIntegration8).
	if (ouroborosDirIsSymlink(dataDir)) return [];
	const file = rulesFile(dataDir);
	if (rulesMissingFile === file && Date.now() - rulesMissingAt < 1000) return [];
	rulesMissingFile = null;
	try {
		const stat = fs.statSync(file);
		// Use mtime + size. On coarse-granularity filesystems, two writes
		// in the same second are caught by the size change. Two SAME-SIZE
		// external writes within the granularity window are not
		// distinguishable (accepted: the plugin's own writes always
		// invalidate; only hand-edits or write-tool bypasses can serve
		// stale rules for a turn or two — OURO-17-05).
		if (rulesCache && rulesCache.file === file && rulesCache.mtimeMs === stat.mtimeMs && rulesCache.size === stat.size) {
			return rulesCache.rules;
		}
		// Bound the read: a multi-MB rules.md (model write-tool bypass or
		// hand-edit) must not be read and split into a giant line array.
		// The appendRule cap is 3000 chars; 1MB is a generous ceiling.
		// A non-regular file (FIFO, socket) would block the read forever.
		if (!stat.isFile() || stat.size > MAX_RULES_FILE_BYTES) return [];
		const text = fs.readFileSync(file, "utf8");
		// Strip control chars and lone surrogates at the injection boundary
		// too. Older plugin versions or hand-editing bypass appendRule's
		// strip. A lone surrogate in the system prompt can make the
		// provider reject the request. Bound the line count: a 1MB file
		// of 1-char lines must not materialize a 500k-element array (the
		// default cap is 50 rules). Keep the LAST MAX_RULES_LINES lines —
		// split-with-limit drops the tail, and the newest rules are the
		// freshest lessons. Scan from the end for the (MAX_RULES_LINES+1)th
		// newline and split only that tail (O(n) scan, no array). A file
		// without a trailing newline keeps at most MAX_RULES_LINES+1 lines.
		let start = 0;
		let newlines = 0;
		for (let i = text.length - 1; i >= 0; i--) {
			if (text[i] === "\n" && ++newlines > MAX_RULES_LINES) {
				start = i + 1;
				break;
			}
		}
		const tail = start === 0 ? text : text.slice(start);
		const rules = tail
			.split("\n")
			.map((l) =>
				l
					.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u2028-\u202e\p{Cf}\u034f\u115f\u1160\u17b4\u17b5\u180b-\u180e\ufe00-\ufe0f\u{e0100}-\u{e01ef}\u3164\uffa0\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000]/gu, "")
					.replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, "")
					.trim()
					// Match the write path: collapse whitespace runs so a
					// hand-edited rules.md renders like a plugin-written
					// one (OURO-SEC-21-02).
					.replace(/\s+/g, " "),
			)
			.filter((l) => l.length > 0);
		rulesCache = { file, mtimeMs: stat.mtimeMs, size: stat.size, rules };
		return rules;
	} catch {
		rulesMissingFile = file;
		rulesMissingAt = Date.now();
		return [];
	}
}

/** Drop the cache after our own writes (mtime alone can miss same-ms writes). */
function invalidateRulesCache(): void {
	rulesCache = null;
	rulesMissingFile = null;
}

/** Normalize a rule for near-duplicate detection (case, punctuation, spaces).
 * Unicode-aware: CJK/kana rules must keep their letters. Otherwise every
 * non-Latin rule collapses to the empty key. */
function dedupKey(rule: string): string {
	return rule
		.toLowerCase()
		.replace(/[^\p{L}\p{N}\s]/gu, "")
		.replace(/\s+/g, " ")
		.trim();
}
/**
 * Append a rule, deduped against existing lines.
 * Returns whether it was added and the resulting count.
 * When at cap, the plugin drops the oldest rule.
 * The freshest lessons always take priority.
 * The plugin truncates oversized rules.
 * The plugin also evicts rules by total characters so every stored rule fits
 * the appendix budget. A stored rule that never appears in the prompt
 * misleads the model.
 *
 * The read-modify-write is synchronous, so callers within one process cannot
 * interleave. Across processes (two pi instances sharing a dataDir) the last
 * rename takes effect, so the write is verified and retried. A lost update
 * is re-applied on the next attempt instead of silently dropped.
 */
export function appendRule(
	dataDir: string,
	rule: string,
	cap: number = DEFAULT_RULES_CAP,
	maxChars: number = DEFAULT_RULES_MAX_CHARS,
): { added: boolean; reason: "added" | "duplicate" | "conflict" | "empty" | "too-large" | "symlink"; count: number; cap: number } {
	// Never write through a symlinked ouroboros dir (same trust boundary
	// as every other ouroboros state path): the lesson would land in the
	// target (RuntimeIntegration8).
	if (ouroborosDirIsSymlink(dataDir)) return { added: false, reason: "symlink", count: 0, cap };
	// A dangling rules.md symlink makes writeRules refuse silently; report
	// the real cause instead of a misleading 'conflict' after the retry
	// loop fails (FixAudit18).
	if (rulesFileIsDanglingSymlink(dataDir)) return { added: false, reason: "symlink", count: 0, cap };
	// Bypass the negative cache. A rules.md created by another process
	// within the 1s window must be seen. Otherwise this write would
	// clobber it.
	invalidateRulesCache();
	// A rules.md over the read bound (model write-tool bypass or
	// hand-edit) must not be silently replaced by the read-modify-write.
	// Preserve it for manual repair.
	try {
		if (fs.statSync(rulesFile(dataDir)).size > MAX_RULES_FILE_BYTES) {
			return { added: false, reason: "too-large", count: 0, cap };
		}
	} catch {
		// missing file is fine
	}
	// Bound the input BEFORE the regex passes: a multi-MB lesson must not
	// materialize multi-MB intermediate strings. Grow the window until
	// the cleaned prefix holds MAX_RULE_CHARS code points, the input is
	// exhausted, or the window hits MAX_RULE_WINDOW: a strip-heavy prefix
	// (control chars, whitespace) must not shrink the lesson to empty,
	// but a pathological multi-MB garbage prefix must not be scanned in
	// full either (FixAudit15).
	let window = Math.min(rule.length, MAX_RULE_CHARS * 2 + 1);
	let normalized = "";
	while (true) {
		const candidate = rule
			.slice(0, window)
			.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u2028-\u202e\p{Cf}\u034f\u115f\u1160\u17b4\u17b5\u180b-\u180e\ufe00-\ufe0f\u{e0100}-\u{e01ef}\u3164\uffa0\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000]/gu, "")
			.replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, "")
			.trim()
			.replace(/\s+/g, " ");
		if ([...candidate].length >= MAX_RULE_CHARS || window >= rule.length || window >= MAX_RULE_WINDOW) {
			normalized = candidate;
			break;
		}
		window = Math.min(rule.length, window * 2, MAX_RULE_WINDOW);
	}
	const chars = Array.from(normalized);
	const capped = chars.length <= MAX_RULE_CHARS ? normalized : chars.slice(0, MAX_RULE_CHARS).join("");
	// A rule with no letter or number content is not a lesson. Every such
	// rule shares the empty dedupKey. The first would shadow all later
	// ones as 'duplicate'. Unicode-aware: CJK lessons (the model can write
	// in any language) must be accepted.
	if (!capped || !/[\p{L}\p{N}]/u.test(capped)) return { added: false, reason: "empty", count: loadRules(dataDir).length, cap };
	for (let attempt = 0; attempt < 3; attempt++) {
		const rules = loadRules(dataDir);
		const key = dedupKey(capped);
		if (rules.some((r) => dedupKey(r) === key)) return { added: false, reason: "duplicate", count: rules.length, cap };
		const next = [...rules, capped];
		while (next.length > cap) next.shift();
		// Evict oldest until the file fits the appendix budget (chars).
		// Track the total once — re-joining per iteration is O(n^2).
		let total = next.join("\n").length + 1;
		while (next.length > 1 && total > maxChars) {
			const dropped = next.shift()!;
			total -= dropped.length + 1;
		}
		// A single rule can still exceed the budget (maxChars < MAX_RULE_CHARS).
		// Truncate it so the stored file always fits the configured budget.
		// Cut by code points, never mid-surrogate-pair (emoji must survive).
		if (next.length === 1 && total > maxChars) {
			next[0] = Array.from(next[0]!).slice(0, Math.max(0, maxChars - 1)).join("");
		}
		writeRules(dataDir, next);
		// Verify: another instance can rename over our write between
		// the read and the rename. If our rule is gone, retry. The written
		// rule can be truncated (single-rule budget), so verify the written
		// form, not the original key.
		const written = next[next.length - 1]!;
		const after = loadRules(dataDir);
		if (after.some((r) => dedupKey(r) === dedupKey(written))) return { added: true, reason: "added", count: after.length, cap };
	}
	return { added: false, reason: "conflict", count: loadRules(dataDir).length, cap };
}

function writeRules(dataDir: string, rules: string[]): void {
	// Never write through a symlinked ouroboros dir (same trust boundary
	// as every other ouroboros state path): the file would land in the
	// target (RuntimeIntegration8). The rules.md FILE symlink write-through
	// below is a separate, documented feature.
	if (ouroborosDirIsSymlink(dataDir)) return;
	let file = rulesFile(dataDir);
	// Write through a symlink instead of replacing it — atomicWrite renames
	// over the link, silently destroying the user's symlink setup. lstatSync
	// (not existsSync) so a DANGLING symlink is still detected.
	try {
		if (fs.lstatSync(file).isSymbolicLink()) {
			file = fs.realpathSync(file);
		}
	} catch {
		// Distinguish a dangling symlink from a genuinely missing file:
		// lstatSync succeeds for a dangling link, so realpathSync's ENOENT
		// means the target is absent. Writing a regular file over the link
		// would silently destroy the user's symlink setup (OURO-SEC-20-01).
		// Refuse instead. Only a truly absent path falls through to the
		// regular-file write.
		try {
			if (fs.lstatSync(file).isSymbolicLink()) return;
		} catch {
			// missing file — write the regular file
		}
	}
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const body = rules.length > 0 ? `${rules.join("\n")}\n` : "";
	atomicWrite(file, body);
	invalidateRulesCache();
}

export function clearRules(dataDir: string): void {
	writeRules(dataDir, []);
}

// ---------------------------------------------------------------------------
// Digests
// ---------------------------------------------------------------------------
/** Mark a digest as injected (renamed so listDigests skips it). */
export function markDigestInjected(dataDir: string, sessionId: string): boolean {
	if (digestsDirIsSymlink(dataDir)) return false;
	const from = digestFile(dataDir, sessionId);
	const to = `${from.slice(0, -".json".length)}.injected.json`;
	// No existsSync pre-check: the rename itself is the atomic claim.
	// ENOENT means another instance renamed the file first, not an error.
	try {
		fs.renameSync(from, to);
		return true;
	} catch {
		return false;
	}
}
/** True when the ouroboros dir is a symlink. last-digest.json lives
 * there; the read/write path must never follow a symlinked ouroboros
 * dir. */
export function ouroborosDirIsSymlink(dataDir: string): boolean {
	try {
		return fs.lstatSync(ouroborosDir(dataDir)).isSymbolicLink();
	} catch {
		return false; // missing dirs are fine
	}
}
/** True when rules.md is a symlink whose target is absent. writeRules
 * refuses to replace such a link (OURO-SEC-20-01); callers report the
 * refusal instead of a misleading success or 'conflict' (FixAudit18).
 * lstatSync succeeds for a dangling link; existsSync follows the link
 * and returns false. */
export function rulesFileIsDanglingSymlink(dataDir: string): boolean {
	try {
		const file = rulesFile(dataDir);
		return fs.lstatSync(file).isSymbolicLink() && !fs.existsSync(file);
	} catch {
		return false; // missing file is fine
	}
}
/** True when last-digest.json is a symlink whose target is absent.
 * saveLastDigest refuses to replace such a link; the /ouroboros digest
 * command reports the refusal instead of 'no digest recorded yet'
 * (FixAudit20). */
export function lastDigestFileIsDanglingSymlink(dataDir: string): boolean {
	try {
		const file = lastDigestFile(dataDir);
		return fs.lstatSync(file).isSymbolicLink() && !fs.existsSync(file);
	} catch {
		return false; // missing file is fine
	}
}
/** True when the digests dir (or its parent) is a symlink. The digest
 * read/delete path must never follow one: a symlinked digests dir would
 * make the plugin read and delete arbitrary *.json files in the target. */
function digestsDirIsSymlink(dataDir: string): boolean {
	if (ouroborosDirIsSymlink(dataDir)) return true;
	try {
		return fs.lstatSync(digestsDir(dataDir)).isSymbolicLink();
	} catch {
		return false; // missing dirs are fine
	}
}

/** Undo an injection mark (rename back to pending) — for sendMessage failure. */
export function unmarkDigestInjected(dataDir: string, sessionId: string): boolean {
	if (digestsDirIsSymlink(dataDir)) return false;
	const from = `${digestFile(dataDir, sessionId).slice(0, -".json".length)}.injected.json`;
	const to = digestFile(dataDir, sessionId);
	try {
		fs.renameSync(from, to);
		return true;
	} catch {
		return false;
	}
}
export function listInjectedDigests(dataDir: string): string[] {
	if (digestsDirIsSymlink(dataDir)) return [];
	try {
		const dir = digestsDir(dataDir);
		if (!fs.existsSync(dir)) return [];
		const entries: Array<{ name: string; mtime: number }> = [];
		for (const f of fs.readdirSync(dir)) {
			if (!f.endsWith(".injected.json")) continue;
			// Same round-trip filter as listDigests: a hand-created
			// "a.b.injected.json" would otherwise be listed but never
			// loadable or deletable, and re-parsed at every session start.
			const stem = f.slice(0, -".injected.json".length);
			if (safeSessionId(stem) !== stem) continue;
			try {
				const st = fs.lstatSync(path.join(dir, f));
				// Skip non-regular files (same rule as listDigests).
				if (!st.isFile()) continue;
				entries.push({ name: f, mtime: st.mtimeMs });
			} catch {
				// unstatable — skip it
			}
		}
		entries.sort((a, b) => b.mtime - a.mtime || a.name.localeCompare(b.name));
		return entries.map((e) => e.name.slice(0, -".injected.json".length));
	} catch {
		return [];
	}
}

export function deleteInjectedDigest(dataDir: string, sessionId: string): boolean {
	if (digestsDirIsSymlink(dataDir)) return false;
	const file = `${digestFile(dataDir, sessionId).slice(0, -".json".length)}.injected.json`;
	try {
		fs.rmSync(file, { force: true });
		return true;
	} catch {
		// Never throw: a failed delete (EACCES, EPERM) must not stall the
		// reconciliation loops — the marker is retried at the next start.
		return false;
	}
}


export function saveDigest(dataDir: string, digest: OuroborosDigest): void {
	// Never write through a symlinked digests dir: the digest would land
	// in the target and be silently lost (listDigests returns []).
	if (digestsDirIsSymlink(dataDir)) return;
	const file = digestFile(dataDir, digest.sessionId);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	atomicWrite(file, `${JSON.stringify(digest, null, 2)}\n`);
}

/** Migrate a legacy digest shape to the current schema (upgrade path).
 * Pre-round-4 digests lack userPromptCount and had string[] failedCommands.
 * Pre-round-5 digests lack toolCalls and assistantText.
 * Pre-round-8 digests can carry unsanitized stopReason keys, model strings,
 * and tool names. The current validator rejects these fields.
 * Deleting them at session_start would silently lose the reflection. */
function migrateDigest(p: unknown): unknown {
	if (typeof p !== "object" || p === null) return p;
	const d = p as Record<string, unknown>;
	if (d.version !== 1) return p;
	if (typeof d.userPromptCount !== "number" && Array.isArray(d.userPrompts)) {
		d.userPromptCount = d.userPrompts.length;
	}
	// Bound the legacy conversion: a crafted multi-million-element
	// string[] must not materialize a multi-MB mapped array. Over-bounded
	// arrays skip the conversion and stay rejected by the validator.
	if (Array.isArray(d.failedCommands) && d.failedCommands.length <= 21 && d.failedCommands.every((c) => typeof c === "string")) {
		d.failedCommands = d.failedCommands.map((c) => ({ command: c, error: "" }));
	}
	if (!Array.isArray(d.toolCalls)) d.toolCalls = [];
	if (!Array.isArray(d.assistantText)) d.assistantText = [];
	// Sanitize the fields the round-8 validator rejects. Strip the
	// control-char class. Re-bound the fields the round-7 writer stored
	// raw (header fields, models, error tool names, tool names,
	// stopReasons keys). A pre-round-8 digest then survives validation.
	// Only WELL-SHAPED elements are sanitized. A wrong-shaped element
	// (never produced by any writer) is left untouched. The validator
	// still rejects the digest as corrupt.
	const strip = (s: unknown): string =>
		typeof s === "string"
			? s
					.replace(/[\u0000-\u001f\u007f-\u009f\u2028-\u202e\p{Cf}\u034f\u115f\u1160\u17b4\u17b5\u180b-\u180e\ufe00-\ufe0f\u{e0100}-\u{e01ef}\u3164\uffa0\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000]/gu, "")
					// Lone surrogates (a legacy UTF-16 slice can split a
					// pair) are removed, not rejected: the digest is
					// repaired so the reflection is not lost.
					.replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, "")
			: "";
	/** Cut by code points: a UTF-16 slice can split a surrogate pair and
	 * emit a lone surrogate into the reflection. Bound the input first:
	 * max code points need at most max*2+1 UTF-16 units, so a multi-MB
	 * string never materializes a multi-MB array. */
	const cpCut = (s: string, max: number): string => {
		const chars = Array.from(s.slice(0, max * 2 + 1));
		return chars.length <= max ? s : chars.slice(0, max).join("");
	};
	// The round-7 writer stored the header fields RAW and unbounded.
	if (typeof d.sessionId === "string") d.sessionId = cpCut(strip(d.sessionId), 200);
	if (typeof d.cwd === "string") d.cwd = cpCut(strip(d.cwd), 2000);
	if (typeof d.startedAt === "string") d.startedAt = cpCut(strip(d.startedAt), 100);
	if (typeof d.endedAt === "string") d.endedAt = cpCut(strip(d.endedAt), 100);
	// Bound each pass to cap+1 elements: a crafted multi-million-element
	// array is still rejected by the validator (length > cap) but never
	// materializes a multi-MB mapped array.
	if (Array.isArray(d.userPrompts)) d.userPrompts = d.userPrompts.slice(0, 13).map((s) => (typeof s === "string" ? strip(s) : s));
	if (Array.isArray(d.assistantText)) d.assistantText = d.assistantText.slice(0, 13).map((s) => (typeof s === "string" ? strip(s) : s));
	if (Array.isArray(d.toolCalls)) {
		d.toolCalls = d.toolCalls.slice(0, 21).map((t) => {
			if (typeof t !== "object" || t === null) return t;
			const tc = t as { tool?: unknown; args?: unknown };
			if (typeof tc.tool !== "string" || typeof tc.args !== "string") return t;
			// The round-6/7 writers stored tool names RAW or UTF-16-sliced.
			return { tool: cpCut(strip(tc.tool), 100), args: strip(tc.args) };
		});
	}
	if (Array.isArray(d.errors)) {
		d.errors = d.errors.slice(0, 21).map((e) => {
			if (typeof e !== "object" || e === null) return e;
			const er = e as { tool?: unknown; summary?: unknown };
			if (typeof er.tool !== "string" || typeof er.summary !== "string") return e;
			// The round-7 writer stored error tool names RAW (unbounded).
			// Cut by code points: a UTF-16 slice can split a surrogate
			// pair and emit a lone surrogate into the reflection.
			return { tool: cpCut(strip(er.tool), 100), summary: strip(er.summary) };
		});
	}
	if (Array.isArray(d.failedCommands)) {
		d.failedCommands = d.failedCommands.slice(0, 21).map((c) => {
			if (typeof c !== "object" || c === null) return c;
			const fc = c as { command?: unknown; error?: unknown };
			if (typeof fc.command !== "string" || typeof fc.error !== "string") return c;
			return { command: strip(fc.command), error: strip(fc.error) };
		});
	}
	// The round-7 writer stored models RAW and unbounded — re-bound both.
	if (Array.isArray(d.models)) d.models = d.models.slice(0, 21).map((s) => (typeof s === "string" ? cpCut(strip(s), 200) : s)).slice(0, 20);
	if (typeof d.stopReasons === "object" && d.stopReasons !== null && !Array.isArray(d.stopReasons)) {
		// Use a null prototype. A '__proto__' key must be an own property.
		// The writer already uses Object.create(null). The load path must
		// match. Iterate with for...in: Object.entries would materialize
		// every key of a crafted object. The loop stops at 21 keys and
		// adds at most 20 non-empty ones — the old add semantics (a key
		// beyond the 20th still lands in `cleaned` when earlier keys
		// stripped to empty, so a bad value still fails validation).
		const cleaned: Record<string, number> = Object.create(null);
		let n = 0;
		let added = 0;
		for (const k in d.stopReasons as Record<string, unknown>) {
			if (++n > 21) break;
			// Keys are sanitized (the round-7 writer stored them raw); values
			// are kept as-is so a non-numeric value still fails validation.
			const key = cpCut(strip(k), 100);
			if (key && added < 20) {
				cleaned[key] = (d.stopReasons as Record<string, unknown>)[k] as number;
				added++;
			}
		}
		// The loop hit the 21-key bound: keys beyond it (possibly with bad
		// values) were never seen. Leave the object unsanitized so the
		// validator's >20-key count check rejects the digest (over-bounded
		// stays rejected).
		if (n > 21) return p;
		d.stopReasons = cleaned;
	}
	return d;
}
export function loadDigest(dataDir: string, sessionId: string): OuroborosDigest | null {
	// Never read through a symlinked digests dir (same trust boundary as
	// every other digest function): the file would come from the target.
	if (digestsDirIsSymlink(dataDir)) return null;
	// A JSON.parse failure means the file is corrupt. Return null so the
	// caller deletes it. A readFileSync failure is transient. Throw so the
	// caller skips the digest and keeps the file. A file over the size
	// bound is not writer-produced: treat it as corrupt (null).
	let text: string;
	try {
		const file = digestFile(dataDir, sessionId);
		// A special file (FIFO, socket, device) would block the read
		// forever. Directories still throw EISDIR (transient — kept).
		const st = fs.lstatSync(file);
		if ((!st.isFile() && !st.isDirectory()) || st.size > MAX_DIGEST_FILE_BYTES) return null;
		text = fs.readFileSync(file, "utf8");
	} catch {
		throw new Error("digest unreadable");
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return null;
	}
	const migrated = migrateDigest(parsed);
	return isValidDigest(migrated) ? (migrated as OuroborosDigest) : null;
}
/** Load a digest that is currently marked injected (awaiting delivery). */
export function readInjectedDigest(dataDir: string, sessionId: string): OuroborosDigest | null {
	// Never read through a symlinked digests dir (same trust boundary as
	// every other digest function): the file would come from the target.
	if (digestsDirIsSymlink(dataDir)) return null;
	// Use the same corrupt-vs-transient split as loadDigest. A parse
	// failure is corruption. The caller deletes the marker. An IO failure
	// is transient. The caller keeps the marker. A file over the size
	// bound is not writer-produced: treat it as corrupt (null).
	let text: string;
	try {
		const file = `${digestFile(dataDir, sessionId).slice(0, -".json".length)}.injected.json`;
		// A special file (FIFO, socket, device) would block the read
		// forever. Directories still throw EISDIR (transient — kept).
		const st = fs.lstatSync(file);
		if ((!st.isFile() && !st.isDirectory()) || st.size > MAX_DIGEST_FILE_BYTES) return null;
		text = fs.readFileSync(file, "utf8");
	} catch {
		throw new Error("injected digest unreadable");
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return null;
	}
	const migrated = migrateDigest(parsed);
	return isValidDigest(migrated) ? (migrated as OuroborosDigest) : null;
}
/** The RAW sessionId field of an injected digest (pre-migration). The
 * marker reconciliation compares the filename against the id the writer
 * hashed: a cleaned (migrated) id may not round-trip when the raw id
 * carried stripped characters or exceeded 200 code points (FixAudit22). */
export function readInjectedDigestRawSessionId(dataDir: string, sessionId: string): string | null {
	if (digestsDirIsSymlink(dataDir)) return null;
	try {
		const file = `${digestFile(dataDir, sessionId).slice(0, -".json".length)}.injected.json`;
		const st = fs.lstatSync(file);
		if ((!st.isFile() && !st.isDirectory()) || st.size > MAX_DIGEST_FILE_BYTES) return null;
		const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
		if (typeof parsed !== "object" || parsed === null) return null;
		const raw = (parsed as Record<string, unknown>).sessionId;
		return typeof raw === "string" ? raw : null;
	} catch {
		return null;
	}
}
/** The RAW sessionId field of a PENDING digest (pre-migration). The
 * pending-injection loop applies the same filename/sessionId consistency
 * check as the marker reconciliation (SEC-26-01). */
export function readDigestRawSessionId(dataDir: string, sessionId: string): string | null {
	if (digestsDirIsSymlink(dataDir)) return null;
	try {
		const file = digestFile(dataDir, sessionId);
		const st = fs.lstatSync(file);
		if ((!st.isFile() && !st.isDirectory()) || st.size > MAX_DIGEST_FILE_BYTES) return null;
		const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
		if (typeof parsed !== "object" || parsed === null) return null;
		const raw = (parsed as Record<string, unknown>).sessionId;
		return typeof raw === "string" ? raw : null;
	} catch {
		return null;
	}
}

/** The last session's digest, kept for /ouroboros digest. Pending digests
 * are consumed at the next session start. The command reads this copy. */
export function lastDigestFile(dataDir: string): string {
	return path.join(ouroborosDir(dataDir), "last-digest.json");
}

export function saveLastDigest(dataDir: string, digest: OuroborosDigest): void {
	// Never write through a symlinked ouroboros dir (same rule as
	// saveDigest): the file would land in the target and be lost. The
	// digests dir does not matter — last-digest.json is not inside it.
	if (ouroborosDirIsSymlink(dataDir)) return;
	try {
		let file = lastDigestFile(dataDir);
		// Mirror the rules.md write-through: a symlinked last-digest.json
		// (dotfiles pattern) must be written through, not replaced by the
		// atomicWrite rename (OURO-SEC-21-01). A dangling link is refused.
		try {
			if (fs.lstatSync(file).isSymbolicLink()) {
				file = fs.realpathSync(file);
			}
		} catch {
			try {
				if (fs.lstatSync(file).isSymbolicLink()) return;
			} catch {
				// missing file — write the regular file
			}
		}
		fs.mkdirSync(path.dirname(file), { recursive: true });
		atomicWrite(file, `${JSON.stringify(digest, null, 2)}\n`);
	} catch {
		// best-effort — the pending digest is the source of truth
	}
}
export function loadLastDigest(dataDir: string): OuroborosDigest | null {
	// Never read through a symlinked ouroboros dir (same rule as
	// listDigests): the file would come from the target. A file over the
	// size bound is not writer-produced: treat it as corrupt (null).
	if (ouroborosDirIsSymlink(dataDir)) return null;
	try {
		const file = lastDigestFile(dataDir);
		// A special file (FIFO, socket, device) would block the read
		// forever. Directories still throw EISDIR (transient — kept).
		const st = fs.statSync(file);
		if ((!st.isFile() && !st.isDirectory()) || st.size > MAX_DIGEST_FILE_BYTES) return null;
		const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
		const migrated = migrateDigest(parsed);
		return isValidDigest(migrated) ? (migrated as OuroborosDigest) : null;
	} catch {
		return null;
	}
}
export function deleteDigest(dataDir: string, sessionId: string): boolean {
	if (digestsDirIsSymlink(dataDir)) return false;
	const file = digestFile(dataDir, sessionId);
	if (!fs.existsSync(file)) return false;
	try {
		// Use force: true. The file can vanish between the check and the
		// delete.
		fs.rmSync(file, { force: true });
		return true;
	} catch {
		// Never throw: a failed delete must not stall the caller.
		return false;
	}
}
export function listDigests(dataDir: string): string[] {
	if (digestsDirIsSymlink(dataDir)) return [];
	try {
		const dir = digestsDir(dataDir);
		if (!fs.existsSync(dir)) return [];
		// Stat each file once, then sort. A comparator calling statSync is
		// O(n log n) syscalls. One unstatable file (broken symlink,
		// concurrent delete) must not fail the whole listing.
		const entries: Array<{ name: string; mtime: number }> = [];
		for (const f of fs.readdirSync(dir)) {
			if (!f.endsWith(".json") || f.endsWith(".injected.json")) continue;
			// List only names that round-trip through safeSessionId. A
			// hand-created "a.b.json" would otherwise be listed but never
			// loadable or deletable. Hashed names (sid-h-<16hex>) round-trip
			// because safeSessionId is idempotent for that shape.
			const stem = f.slice(0, -".json".length);
			if (safeSessionId(stem) !== stem) continue;
			try {
				const st = fs.lstatSync(path.join(dir, f));
				// Skip non-regular files: a directory at a digest path
				// would otherwise be listed and re-attempted (EISDIR) at
				// every session start, accumulating forever (OURO-17-04).
				if (!st.isFile()) continue;
				entries.push({ name: f, mtime: st.mtimeMs });
			} catch {
				// unstatable — skip it
			}
		}
		entries.sort((a, b) => b.mtime - a.mtime || a.name.localeCompare(b.name));
		return entries.map((e) => e.name.slice(0, -".json".length));
	} catch {
		return [];
	}
}
export function isValidDigest(p: unknown): p is OuroborosDigest {
	if (typeof p !== "object" || p === null) return false;
	const d = p as OuroborosDigest;
	const isCount = (v: unknown): boolean => typeof v === "number" && Number.isFinite(v) && v >= 0;
	// A lone surrogate (a legacy UTF-16 slice can split a pair) must not
	// reach the reflection message. The writer and migrateDigest strip
	// them; this is the last line of defense.
	const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
	// The writer caps by code points. The validator must measure the same
	// way. Otherwise astral-heavy content would fail validation. The
	// counter stops at max+1: a multi-MB string never materializes a
	// multi-MB array.
	const cpLen = (s: string, max: number): number => {
		let n = 0;
		for (const _ of s) {
			if (++n > max) return n;
		}
		return n;
	};
	const clean = (v: unknown, max: number): v is string =>
		typeof v === "string" && cpLen(v, max) <= max && !/[\u0000-\u001f\u007f-\u009f\u2028-\u202e\p{Cf}\u034f\u115f\u1160\u17b4\u17b5\u180b-\u180e\ufe00-\ufe0f\u{e0100}-\u{e01ef}\u3164\uffa0\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000]/u.test(v) && !LONE_SURROGATE.test(v);
	const noControl = (s: string): boolean => !/[\u0000-\u001f\u007f-\u009f\u2028-\u202e\p{Cf}\u034f\u115f\u1160\u17b4\u17b5\u180b-\u180e\ufe00-\ufe0f\u{e0100}-\u{e01ef}\u3164\uffa0\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000]/u.test(s) && !LONE_SURROGATE.test(s);
	const strArr = (v: unknown, max: number, maxLen: number): boolean =>
		Array.isArray(v) && v.length <= max && v.every((e) => typeof e === "string" && cpLen(e, maxLen) <= maxLen && noControl(e));
	const errArr = (v: unknown, max: number): boolean =>
		Array.isArray(v) &&
		v.length <= max &&
		v.every(
			(e) =>
				typeof e === "object" &&
				e !== null &&
				typeof (e as { tool?: unknown }).tool === "string" &&
				cpLen((e as { tool: string }).tool, 100) <= 100 &&
				noControl((e as { tool: string }).tool) &&
				typeof (e as { summary?: unknown }).summary === "string" &&
				cpLen((e as { summary: string }).summary, 200) <= 200 &&
				noControl((e as { summary: string }).summary),
		);
	const cmdArr = (v: unknown, max: number): boolean =>
		Array.isArray(v) &&
		v.length <= max &&
		v.every(
			(e) =>
				typeof e === "object" &&
				e !== null &&
				typeof (e as { command?: unknown }).command === "string" &&
				cpLen((e as { command: string }).command, 200) <= 200 &&
				noControl((e as { command: string }).command) &&
				typeof (e as { error?: unknown }).error === "string" &&
				cpLen((e as { error: string }).error, 200) <= 200 &&
				noControl((e as { error: string }).error),
		);
	const toolCallArr = (v: unknown, max: number): boolean =>
		Array.isArray(v) &&
		v.length <= max &&
		v.every(
			(e) =>
				typeof e === "object" &&
				e !== null &&
				typeof (e as { tool?: unknown }).tool === "string" &&
				cpLen((e as { tool: string }).tool, 100) <= 100 &&
				noControl((e as { tool: string }).tool) &&
				typeof (e as { args?: unknown }).args === "string" &&
				cpLen((e as { args: string }).args, 200) <= 200 &&
				noControl((e as { args: string }).args),
		);
	// Bounded key/value scan: Object.keys/Object.values would materialize
	// every key of a crafted object. The loop stops at 21 keys.
	const stopReasonsOk = (o: object): boolean => {
		let n = 0;
		for (const k in o) {
			if (++n > 20) return false;
			if (cpLen(k, 100) > 100) return false;
			if (/[\u0000-\u001f\u007f-\u009f\u2028-\u202e\p{Cf}\u034f\u115f\u1160\u17b4\u17b5\u180b-\u180e\ufe00-\ufe0f\u{e0100}-\u{e01ef}\u3164\uffa0\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000]/u.test(k)) return false;
			if (LONE_SURROGATE.test(k)) return false;
			const v = (o as Record<string, unknown>)[k];
			if (typeof v !== "number" || !Number.isFinite(v) || v < 0) return false;
		}
		return true;
	};
	return (
		d.version === 1 &&
		clean(d.sessionId, 200) &&
		clean(d.cwd, 2000) &&
		clean(d.startedAt, 100) &&
		clean(d.endedAt, 100) &&
		strArr(d.userPrompts, 12, 300) &&
		toolCallArr(d.toolCalls, 20) &&
		strArr(d.assistantText, 12, 300) &&
		errArr(d.errors, 20) &&
		cmdArr(d.failedCommands, 20) &&
		typeof d.stopReasons === "object" &&
		d.stopReasons !== null &&
		!Array.isArray(d.stopReasons) &&
		stopReasonsOk(d.stopReasons) &&
		strArr(d.models, 20, 200) &&
		isCount(d.compactions) &&
		isCount(d.messageCount) &&
		isCount(d.userPromptCount) &&
		typeof d.usage === "object" &&
		d.usage !== null &&
		isCount(d.usage.input) &&
		isCount(d.usage.output) &&
		isCount(d.usage.cost)
	);
}
// ---------------------------------------------------------------------------
// Skills
// ---------------------------------------------------------------------------

/** Skill names follow the Agent Skills spec: lowercase letters, digits, hyphens. */
export function isValidSkillName(name: string): boolean {
	return /^[a-z0-9]+(-[a-z0-9]+)*$/.test(name) && name.length <= 64;
}

/** Normalize a description for safe YAML frontmatter (single line).
 * Strip control chars and lone surrogates: the description is advertised
 * in the system prompt (pi's escapeXml does not escape them), and a lone
 * surrogate can make the provider reject the request. */
export function normalizeDescription(description: string): string {
	return description
		.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u2028-\u202e\p{Cf}\u034f\u115f\u1160\u17b4\u17b5\u180b-\u180e\ufe00-\ufe0f\u{e0100}-\u{e01ef}\u3164\uffa0\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000]/gu, "")
		.replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, "")
		.trim()
		.replace(/\s+/g, " ");
}

/** Write a skill and return its SKILL.md path. Refuses to overwrite. */
export function writeSkill(dataDir: string, name: string, description: string, body: string): string {
	// Never write through a symlinked skills root or skill subdir: the
	// SKILL.md would land in the target (same trust boundary as the
	// digests guards). A missing skills root is fine — mkdir creates it.
	// lstatSync (not existsSync): a DANGLING symlink is still detected.
	const skillsRoot = skillsDir(dataDir);
	let skillsRootStat: fs.Stats | null = null;
	try {
		skillsRootStat = fs.lstatSync(skillsRoot);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
	}
	if (skillsRootStat?.isSymbolicLink()) {
		throw new Error("skills dir is a symlink — refusing to write through it");
	}
	const dir = path.join(skillsRoot, name);
	const file = path.join(dir, "SKILL.md");
	// Check the subdir BEFORE mkdir: a dangling symlink at skills/<name>
	// would make mkdirSync throw a misleading ENOENT (RuntimeIntegration6).
	let dirStat: fs.Stats | null = null;
	try {
		dirStat = fs.lstatSync(dir);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
	}
	if (dirStat?.isSymbolicLink()) {
		throw new Error(`skill dir "${name}" is a symlink — refusing to write through it`);
	}
	fs.mkdirSync(dir, { recursive: true });
	if (fs.lstatSync(dir).isSymbolicLink()) {
		throw new Error(`skill dir "${name}" is a symlink — refusing to write through it`);
	}
	// JSON.stringify produces a valid YAML double-quoted scalar.
	// Descriptions with colons or leading dashes must not break the
	// frontmatter. The body is also stripped: pi advertises the skill
	// content in the system prompt.
	const content = `---\nname: ${name}\ndescription: ${JSON.stringify(normalizeDescription(description))}\n---\n\n${body
		.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u2028-\u202e\p{Cf}\u034f\u115f\u1160\u17b4\u17b5\u180b-\u180e\ufe00-\ufe0f\u{e0100}-\u{e01ef}\u3164\uffa0\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000]/gu, "")
		.replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, "")
		.trim()}\n`;
	// The no-overwrite check must be atomic. Two concurrent writers can
	// both pass an existsSync pre-check. The second rename would then
	// overwrite the first. Write a unique tmp, then link it to the final
	// name. Link fails with EEXIST if the target exists. The tmp is then
	// removed.
	const tmp = `${file}.${process.pid}.${Date.now()}.${tmpCounter++}.tmp`;
	const fd = fs.openSync(tmp, "wx");
	try {
		fs.writeFileSync(fd, content);
		fs.fsyncSync(fd);
	} catch (err) {
		// A failed write (disk full, IO error) must not leak the tmp.
		fs.rmSync(tmp, { force: true });
		throw err;
	} finally {
		fs.closeSync(fd);
	}
	try {
		fs.linkSync(tmp, file);
	} catch (err) {
		fs.rmSync(tmp, { force: true });
		const code = (err as NodeJS.ErrnoException).code;
		if (code === "EEXIST") {
			throw new Error(`skill "${name}" already exists at ${file} — pick a different name or remove it first`);
		}
		if (code === "EPERM" || code === "ENOTSUP" || code === "ENOSYS" || code === "EOPNOTSUPP") {
			// The filesystem has no hard links (FAT32, exFAT, some network
			// mounts). Fall back to an exclusive open of the final path.
			// The no-overwrite guarantee holds. A crash mid-write can leave
			// a partial file (accepted).
			try {
				const fd2 = fs.openSync(file, "wx");
				try {
					fs.writeFileSync(fd2, content);
					fs.fsyncSync(fd2);
				} catch (err2) {
					// A thrown write (disk full, IO error) must not leave a
					// partial file that blocks future writes of this name.
					fs.rmSync(file, { force: true });
					throw err2;
				} finally {
					fs.closeSync(fd2);
				}
			} catch (err2) {
				if ((err2 as NodeJS.ErrnoException).code === "EEXIST") {
					throw new Error(`skill "${name}" already exists at ${file} — pick a different name or remove it first`);
				}
				throw err2;
			}
			return file;
		}
		throw err;
	}
	fs.rmSync(tmp, { force: true });
	return file;
}

/** Names of skills ouroboros has written (directories under the skills dir).
 * No cache: a SKILL.md created or deleted inside an existing subdir does
 * not change the root mtime, so a root-keyed cache would go stale
 * (OURO-17-06). The listing is a few syscalls — negligible per turn. */
export function listSkills(dataDir: string): string[] {
	try {
		const dir = skillsDir(dataDir);
		// Never read through a symlinked skills root (same trust boundary
		// as the digests guards): the subdir names would come from the
		// target.
		if (!fs.existsSync(dir) || fs.lstatSync(dir).isSymbolicLink()) return [];
		return fs
			.readdirSync(dir, { withFileTypes: true })
			.filter((e) => e.isDirectory() && fs.existsSync(path.join(dir, e.name, "SKILL.md")))
			.map((e) => e.name)
			.sort();
	} catch {
		return [];
	}
}

/** Remove stale atomicWrite tmp files (crashes leave them behind). */
export function cleanupStaleTmp(dataDir: string, maxAgeMs: number = 60 * 60 * 1000): void {
	const cutoff = Date.now() - maxAgeMs;
	// atomicWrite is used for rules, digests, AND skills. Skill tmps are
	// stored one level deeper: skills/<name>/SKILL.md.*.tmp.
	// Lstat-check every scanned dir. A symlinked ouroboros, digests, or
	// skills dir must not make the cleanup delete *.tmp files inside an
	// arbitrary target. The digests dir is only scanned when the ouroboros
	// dir is real. A symlinked ouroboros dir makes the digests path
	// resolve inside the target.
	const dirs: string[] = [];
	const ouroboros = ouroborosDir(dataDir);
	let ouroborosReal = false;
	try {
		ouroborosReal = !fs.lstatSync(ouroboros).isSymbolicLink();
		if (ouroborosReal) dirs.push(ouroboros);
	} catch {
		// missing — nothing to scan
	}
	if (ouroborosReal) {
		try {
			if (!fs.lstatSync(digestsDir(dataDir)).isSymbolicLink()) dirs.push(digestsDir(dataDir));
		} catch {
			// missing — nothing to scan
		}
	}
	try {
		// Only real directories are scanned — a symlinked skill dir must
		// not make the cleanup delete *.tmp files inside an arbitrary
		// target (readdirSync follows links). A symlinked skills ROOT
		// skips only this scan; the ouroboros and digests scans above
		// still run.
		if (!fs.lstatSync(skillsDir(dataDir)).isSymbolicLink()) {
			for (const e of fs.readdirSync(skillsDir(dataDir), { withFileTypes: true })) {
				if (e.isDirectory() && !e.isSymbolicLink()) {
					dirs.push(path.join(skillsDir(dataDir), e.name));
				}
			}
		}
	} catch {
		// skills dir missing — nothing to scan
	}
	for (const dir of dirs) {
		let names: string[];
		try {
			names = fs.readdirSync(dir);
		} catch {
			continue;
		}
		for (const name of names) {
			if (!name.endsWith(".tmp")) continue;
			try {
				if (fs.statSync(path.join(dir, name)).mtimeMs < cutoff) {
					fs.rmSync(path.join(dir, name), { force: true });
				}
			} catch {
				// best-effort
			}
		}
	}
}

let tmpCounter = 0;

function atomicWrite(file: string, content: string): void {
	// pid + ms + monotonic counter: unique even for concurrent writes from
	// the same process in the same millisecond.
	const tmp = `${file}.${process.pid}.${Date.now()}.${tmpCounter++}.tmp`;
	// "wx" = O_CREAT|O_EXCL. A pre-created symlink at the tmp path fails
	// the open instead of being followed.
	const fd = fs.openSync(tmp, "wx");
	try {
		fs.writeFileSync(fd, content);
		// Fsync before rename. On power loss, ext4 delayed allocation can
		// make the rename durable before the data blocks. This leaves an
		// empty file.
		fs.fsyncSync(fd);
		fs.closeSync(fd);
		fs.renameSync(tmp, file);
	} catch (err) {
		// A failed write or rename (disk full, IO error, EACCES on the
		// target dir) must not leak the tmp.
		try {
			fs.closeSync(fd);
		} catch {
			// already closed
		}
		fs.rmSync(tmp, { force: true });
		throw err;
	}
}

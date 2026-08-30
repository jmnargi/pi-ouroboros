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
	const file = rulesFile(dataDir);
	if (rulesMissingFile === file && Date.now() - rulesMissingAt < 1000) return [];
	rulesMissingFile = null;
	try {
		const stat = fs.statSync(file);
		// Use mtime + size. On coarse-granularity filesystems, two writes
		// in the same second are caught by the size change.
		if (rulesCache && rulesCache.file === file && rulesCache.mtimeMs === stat.mtimeMs && rulesCache.size === stat.size) {
			return rulesCache.rules;
		}
		const text = fs.readFileSync(file, "utf8");
		// Strip control chars and lone surrogates at the injection boundary
		// too. Older plugin versions or hand-editing bypass appendRule's
		// strip. A lone surrogate in the system prompt can make the
		// provider reject the request.
		const rules = text
			.split("\n")
			.map((l) =>
				l
					.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f]/g, "")
					.replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, "")
					.trim(),
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
): { added: boolean; reason: "added" | "duplicate" | "conflict" | "empty"; count: number; cap: number } {
	// Bypass the negative cache. A rules.md created by another process
	// within the 1s window must be seen. Otherwise this write would
	// clobber it.
	// Strip control chars and lone surrogates: a rule is injected into the
	// system prompt verbatim. The cap is by code points — a UTF-16 slice
	// could split a surrogate pair and store a lone surrogate.
	const normalized = rule
		.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f]/g, "")
		.replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, "")
		.trim()
		.replace(/\s+/g, " ");
	// Bound the input before the code-point pass: a multi-MB lesson must
	// not materialize a multi-MB array. MAX_RULE_CHARS*2+1 units cover the
	// first MAX_RULE_CHARS code points even when every one is astral.
	const bounded = normalized.slice(0, MAX_RULE_CHARS * 2 + 1);
	const chars = Array.from(bounded);
	const capped = chars.length <= MAX_RULE_CHARS ? bounded : chars.slice(0, MAX_RULE_CHARS).join("");
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
	let file = rulesFile(dataDir);
	// Write through a symlink instead of replacing it — atomicWrite renames
	// over the link, silently destroying the user's symlink setup. lstatSync
	// (not existsSync) so a DANGLING symlink is still detected.
	try {
		if (fs.lstatSync(file).isSymbolicLink()) {
			file = fs.realpathSync(file);
		}
	} catch {
		// dangling symlink or missing file — write the regular file
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
/** True when the digests dir (or its parent) is a symlink. The digest
 * read/delete path must never follow one: a symlinked digests dir would
 * make the plugin read and delete arbitrary *.json files in the target. */
function digestsDirIsSymlink(dataDir: string): boolean {
	try {
		return fs.lstatSync(ouroborosDir(dataDir)).isSymbolicLink() || fs.lstatSync(digestsDir(dataDir)).isSymbolicLink();
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
				entries.push({ name: f, mtime: fs.statSync(path.join(dir, f)).mtimeMs });
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
	fs.rmSync(file, { force: true });
	return true;
}


export function saveDigest(dataDir: string, digest: OuroborosDigest): void {
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
	if (Array.isArray(d.failedCommands) && d.failedCommands.every((c) => typeof c === "string")) {
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
					.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f]/g, "")
					// Lone surrogates (a legacy UTF-16 slice can split a
					// pair) are removed, not rejected: the digest is
					// repaired so the reflection is not lost.
					.replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, "")
			: "";
	/** Cut by code points: a UTF-16 slice can split a surrogate pair and
	 * emit a lone surrogate into the reflection. */
	const cpCut = (s: string, max: number): string => {
		const chars = Array.from(s);
		return chars.length <= max ? s : chars.slice(0, max).join("");
	};
	// The round-7 writer stored the header fields RAW and unbounded.
	if (typeof d.sessionId === "string") d.sessionId = cpCut(strip(d.sessionId), 200);
	if (typeof d.cwd === "string") d.cwd = cpCut(strip(d.cwd), 2000);
	if (typeof d.startedAt === "string") d.startedAt = cpCut(strip(d.startedAt), 100);
	if (typeof d.endedAt === "string") d.endedAt = cpCut(strip(d.endedAt), 100);
	// Fields the round-7 writer already bounded are only control-char
	// stripped. A longer value is corruption and stays rejected.
	if (Array.isArray(d.userPrompts)) d.userPrompts = d.userPrompts.map((s) => (typeof s === "string" ? strip(s) : s));
	if (Array.isArray(d.assistantText)) d.assistantText = d.assistantText.map((s) => (typeof s === "string" ? strip(s) : s));
	if (Array.isArray(d.toolCalls)) {
		d.toolCalls = d.toolCalls.map((t) => {
			if (typeof t !== "object" || t === null) return t;
			const tc = t as { tool?: unknown; args?: unknown };
			if (typeof tc.tool !== "string" || typeof tc.args !== "string") return t;
			// The round-6/7 writers stored tool names RAW or UTF-16-sliced.
			return { tool: cpCut(strip(tc.tool), 100), args: strip(tc.args) };
		});
	}
	if (Array.isArray(d.errors)) {
		d.errors = d.errors.map((e) => {
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
		d.failedCommands = d.failedCommands.map((c) => {
			if (typeof c !== "object" || c === null) return c;
			const fc = c as { command?: unknown; error?: unknown };
			if (typeof fc.command !== "string" || typeof fc.error !== "string") return c;
			return { command: strip(fc.command), error: strip(fc.error) };
		});
	}
	// The round-7 writer stored models RAW and unbounded — re-bound both.
	if (Array.isArray(d.models)) d.models = d.models.map((s) => (typeof s === "string" ? cpCut(strip(s), 200) : s)).slice(0, 20);
	if (typeof d.stopReasons === "object" && d.stopReasons !== null && !Array.isArray(d.stopReasons)) {
		// Use a null prototype. A '__proto__' key must be an own property.
		// The writer already uses Object.create(null). The load path must
		// match.
		const cleaned: Record<string, number> = Object.create(null);
		for (const [k, v] of Object.entries(d.stopReasons as Record<string, unknown>)) {
			// Keys are sanitized (the round-7 writer stored them raw); values
			// are kept as-is so a non-numeric value still fails validation.
			const key = cpCut(strip(k), 100);
			if (key && Object.keys(cleaned).length < 20) {
				cleaned[key] = v as number;
			}
		}
		d.stopReasons = cleaned;
	}
	return d;
}

export function loadDigest(dataDir: string, sessionId: string): OuroborosDigest | null {
	// A JSON.parse failure means the file is corrupt. Return null so the
	// caller deletes it. A readFileSync failure is transient. Throw so the
	// caller skips the digest and keeps the file.
	let text: string;
	try {
		text = fs.readFileSync(digestFile(dataDir, sessionId), "utf8");
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
	// Use the same corrupt-vs-transient split as loadDigest. A parse
	// failure is corruption. The caller deletes the marker. An IO failure
	// is transient. The caller keeps the marker.
	let text: string;
	try {
		const file = `${digestFile(dataDir, sessionId).slice(0, -".json".length)}.injected.json`;
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

/** The last session's digest, kept for /ouroboros digest. Pending digests
 * are consumed at the next session start. The command reads this copy. */
export function lastDigestFile(dataDir: string): string {
	return path.join(ouroborosDir(dataDir), "last-digest.json");
}

export function saveLastDigest(dataDir: string, digest: OuroborosDigest): void {
	try {
		const file = lastDigestFile(dataDir);
		fs.mkdirSync(path.dirname(file), { recursive: true });
		atomicWrite(file, `${JSON.stringify(digest, null, 2)}\n`);
	} catch {
		// best-effort — the pending digest is the source of truth
	}
}

export function loadLastDigest(dataDir: string): OuroborosDigest | null {
	try {
		const parsed: unknown = JSON.parse(fs.readFileSync(lastDigestFile(dataDir), "utf8"));
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
	// Use force: true. The file can vanish between the check and the
	// delete.
	fs.rmSync(file, { force: true });
	return true;
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
				entries.push({ name: f, mtime: fs.statSync(path.join(dir, f)).mtimeMs });
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
	// way. Otherwise astral-heavy content would fail validation.
	const cpLen = (s: string): number => Array.from(s).length;
	const clean = (v: unknown, max: number): v is string =>
		typeof v === "string" && cpLen(v) <= max && !/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f]/.test(v) && !LONE_SURROGATE.test(v);
	const noControl = (s: string): boolean => !/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f]/.test(s) && !LONE_SURROGATE.test(s);
	const strArr = (v: unknown, max: number, maxLen: number): boolean =>
		Array.isArray(v) && v.length <= max && v.every((e) => typeof e === "string" && cpLen(e) <= maxLen && noControl(e));
	const errArr = (v: unknown, max: number): boolean =>
		Array.isArray(v) &&
		v.length <= max &&
		v.every(
			(e) =>
				typeof e === "object" &&
				e !== null &&
				typeof (e as { tool?: unknown }).tool === "string" &&
				cpLen((e as { tool: string }).tool) <= 100 &&
				noControl((e as { tool: string }).tool) &&
				typeof (e as { summary?: unknown }).summary === "string" &&
				cpLen((e as { summary: string }).summary) <= 200 &&
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
				cpLen((e as { command: string }).command) <= 200 &&
				noControl((e as { command: string }).command) &&
				typeof (e as { error?: unknown }).error === "string" &&
				cpLen((e as { error: string }).error) <= 200 &&
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
				cpLen((e as { tool: string }).tool) <= 100 &&
				noControl((e as { tool: string }).tool) &&
				typeof (e as { args?: unknown }).args === "string" &&
				cpLen((e as { args: string }).args) <= 200 &&
				noControl((e as { args: string }).args),
		);
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
		Object.keys(d.stopReasons).length <= 20 &&
		Object.keys(d.stopReasons).every((k) => cpLen(k) <= 100 && !/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f]/.test(k) && !LONE_SURROGATE.test(k)) &&
		Object.values(d.stopReasons).every((v) => typeof v === "number" && Number.isFinite(v) && v >= 0) &&
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

/** Normalize a description for safe YAML frontmatter (single line). */
export function normalizeDescription(description: string): string {
	return description.trim().replace(/\s+/g, " ");
}

/** Write a skill and return its SKILL.md path. Refuses to overwrite. */
export function writeSkill(dataDir: string, name: string, description: string, body: string): string {
	const dir = path.join(skillsDir(dataDir), name);
	const file = path.join(dir, "SKILL.md");
	fs.mkdirSync(dir, { recursive: true });
	// JSON.stringify produces a valid YAML double-quoted scalar.
	// Descriptions with colons or leading dashes must not break the
	// frontmatter.
	const content = `---\nname: ${name}\ndescription: ${JSON.stringify(normalizeDescription(description))}\n---\n\n${body.trim()}\n`;
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
			skillsCache = null;
			return file;
		}
		throw err;
	}
	fs.rmSync(tmp, { force: true });
	skillsCache = null;
	return file;
}

/** In-memory skills cache: updateStatus reads it every turn. */
let skillsCache: { dir: string; mtimeMs: number; size: number; names: string[] } | null = null;

/** Names of skills ouroboros has written (directories under the skills dir). */
export function listSkills(dataDir: string): string[] {
	try {
		const dir = skillsDir(dataDir);
		if (!fs.existsSync(dir)) return [];
		const stat = fs.statSync(dir);
		// A new skill directory changes the parent's mtime+size, so the
		// cache stays valid until the next write.
		if (skillsCache && skillsCache.dir === dir && skillsCache.mtimeMs === stat.mtimeMs && skillsCache.size === stat.size) {
			return skillsCache.names;
		}
		const names = fs
			.readdirSync(dir, { withFileTypes: true })
			.filter((e) => e.isDirectory() && fs.existsSync(path.join(dir, e.name, "SKILL.md")))
			.map((e) => e.name)
			.sort();
		skillsCache = { dir, mtimeMs: stat.mtimeMs, size: stat.size, names };
		return names;
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
		if (fs.lstatSync(skillsDir(dataDir)).isSymbolicLink()) return;
		// Only real directories are scanned — a symlinked skill dir must
		// not make the cleanup delete *.tmp files inside an arbitrary
		// target (readdirSync follows links).
		for (const e of fs.readdirSync(skillsDir(dataDir), { withFileTypes: true })) {
			if (e.isDirectory() && !e.isSymbolicLink()) {
				dirs.push(path.join(skillsDir(dataDir), e.name));
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
	} catch (err) {
		// A failed write (disk full, IO error) must not leak the tmp.
		fs.rmSync(tmp, { force: true });
		throw err;
	} finally {
		fs.closeSync(fd);
	}
	fs.renameSync(tmp, file);
}

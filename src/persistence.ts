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
 * All writes are atomic (temp + rename) and all reads degrade to empty state
 * on corrupt files — ouroboros must never crash pi over a half-written file.
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
	// The sid-h- prefix is RESERVED for hashed ids — a verbatim id with that
	// shape would collide with the hash of an unsafe id.
	if (SAFE_ID.test(sessionId) && !sessionId.includes("..") && !sessionId.startsWith("sid-h-")) return sessionId;
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
/** True while rules.md is known to be absent — avoids a throwing statSync. */
let rulesMissing = false;
/** When rulesMissing was set — the negative cache is time-bounded so an
 * externally created rules.md (another pi instance, the user) is picked up. */
let rulesMissingAt = 0;

/** Load rules as a list of non-empty lines (comments starting with `#` kept). */
export function loadRules(dataDir: string): string[] {
	const file = rulesFile(dataDir);
	if (rulesMissing && Date.now() - rulesMissingAt < 1000) return [];
	rulesMissing = false;
	try {
		const stat = fs.statSync(file);
		// mtime + size: on coarse-granularity filesystems (1s), two writes in
		// the same bucket are still caught by the size change.
		if (rulesCache && rulesCache.file === file && rulesCache.mtimeMs === stat.mtimeMs && rulesCache.size === stat.size) {
			return rulesCache.rules;
		}
		const text = fs.readFileSync(file, "utf8");
		const rules = text
			.split("\n")
			.map((l) => l.trim())
			.filter((l) => l.length > 0);
		rulesCache = { file, mtimeMs: stat.mtimeMs, size: stat.size, rules };
		return rules;
	} catch {
		rulesMissing = true;
		rulesMissingAt = Date.now();
		return [];
	}
}

/** Drop the cache after our own writes (mtime alone can miss same-ms writes). */
function invalidateRulesCache(): void {
	rulesCache = null;
	rulesMissing = false;
}

/** Normalize a rule for near-duplicate detection (case, punctuation, spaces). */
function dedupKey(rule: string): string {
	return rule
		.toLowerCase()
		.replace(/[^a-z0-9\s]/g, "")
		.replace(/\s+/g, " ")
		.trim();
}
/**
 * Append a rule, deduped against existing lines. Returns whether it was added
 * and the resulting count. When at cap, the oldest rule is dropped so the
 * freshest lessons always win. Oversized rules are truncated.
 *
 * The read-modify-write is synchronous, so callers within one process cannot
 * interleave. Across processes (two pi instances sharing a dataDir) the last
 * rename wins, so the write is verified and retried: a lost update is
 * re-applied on the next attempt instead of silently dropped.
 */
export function appendRule(dataDir: string, rule: string, cap: number = DEFAULT_RULES_CAP): { added: boolean; reason: "added" | "duplicate" | "conflict"; count: number; cap: number } {
	// Strip control chars: a rule is injected into the system prompt verbatim.
	const normalized = rule
		.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u2028\u2029]/g, "")
		.trim()
		.replace(/\s+/g, " ")
		.slice(0, MAX_RULE_CHARS);
	if (!normalized) return { added: false, reason: "conflict", count: loadRules(dataDir).length, cap };
	for (let attempt = 0; attempt < 3; attempt++) {
		const rules = loadRules(dataDir);
		const key = dedupKey(normalized);
		if (rules.some((r) => dedupKey(r) === key)) return { added: false, reason: "duplicate", count: rules.length, cap };
		const next = [...rules, normalized];
		while (next.length > cap) next.shift();
		writeRules(dataDir, next);
		// Verify: another instance may have renamed over our write between
		// the read and the rename. If our rule is gone, retry.
		const after = loadRules(dataDir);
		if (after.some((r) => dedupKey(r) === key)) return { added: true, reason: "added", count: after.length, cap };
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
	const from = digestFile(dataDir, sessionId);
	const to = `${from.slice(0, -".json".length)}.injected.json`;
	// No existsSync pre-check: the rename itself is the atomic claim. A
	// concurrent instance may have renamed the file first — ENOENT means
	// "someone else won", not an error.
	try {
		fs.renameSync(from, to);
		return true;
	} catch {
		return false;
	}
}

/** Undo an injection mark (rename back to pending) — for sendMessage failure. */
export function unmarkDigestInjected(dataDir: string, sessionId: string): boolean {
	const from = `${digestFile(dataDir, sessionId).slice(0, -".json".length)}.injected.json`;
	const to = digestFile(dataDir, sessionId);
	try {
		fs.renameSync(from, to);
		return true;
	} catch {
		return false;
	}
}
/** Injected digest session ids (awaiting delivery, then cleanup). */
export function listInjectedDigests(dataDir: string): string[] {
	try {
		const dir = digestsDir(dataDir);
		if (!fs.existsSync(dir)) return [];
		return fs
			.readdirSync(dir)
			.filter((f) => f.endsWith(".injected.json"))
			.map((f) => f.slice(0, -".injected.json".length));
	} catch {
		return [];
	}
}

export function deleteInjectedDigest(dataDir: string, sessionId: string): boolean {
	const file = `${digestFile(dataDir, sessionId).slice(0, -".json".length)}.injected.json`;
	if (!fs.existsSync(file)) return false;
	fs.rmSync(file, { force: true });
	return true;
}


export function saveDigest(dataDir: string, digest: OuroborosDigest): void {
	const file = digestFile(dataDir, digest.sessionId);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	atomicWrite(file, `${JSON.stringify(digest, null, 2)}\n`);
}

export function loadDigest(dataDir: string, sessionId: string): OuroborosDigest | null {
	try {
		const parsed: unknown = JSON.parse(fs.readFileSync(digestFile(dataDir, sessionId), "utf8"));
		return isValidDigest(parsed) ? parsed : null;
	} catch {
		return null;
	}
}

/** The last session's digest, kept for /ouroboros digest (pending digests
 * are consumed at the next session start, so the command reads this copy). */
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
		return isValidDigest(parsed) ? parsed : null;
	} catch {
		return null;
	}
}
export function deleteDigest(dataDir: string, sessionId: string): boolean {
	const file = digestFile(dataDir, sessionId);
	if (!fs.existsSync(file)) return false;
	// force: true — the file may vanish between the check and the delete
	// (concurrent cleanup by another pi instance).
	fs.rmSync(file, { force: true });
	return true;
}

/** Pending digest session ids, newest first (by mtime, then name). */
export function listDigests(dataDir: string): string[] {
	try {
		const dir = digestsDir(dataDir);
		if (!fs.existsSync(dir)) return [];
		// Stat each file ONCE, then sort — a comparator calling statSync is
		// O(n log n) syscalls (measured: 241k statx for 10k digests). One
		// unstatable file (broken symlink, concurrent delete) must not fail
		// the whole listing.
		const entries: Array<{ name: string; mtime: number }> = [];
		for (const f of fs.readdirSync(dir)) {
			if (!f.endsWith(".json") || f.endsWith(".injected.json")) continue;
			// Only names that round-trip through safeSessionId are listed —
			// a hand-created "a.b.json" would otherwise be listed but never
			// loadable or deletable.
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

function isValidDigest(p: unknown): p is OuroborosDigest {
	if (typeof p !== "object" || p === null) return false;
	const d = p as OuroborosDigest;
	const isCount = (v: unknown): boolean => typeof v === "number" && Number.isFinite(v) && v >= 0;
	const clean = (v: unknown, max: number): v is string => typeof v === "string" && v.length <= max && !/[\u0000-\u001f\u007f]/.test(v);
	const strArr = (v: unknown, max: number, maxLen: number): boolean =>
		Array.isArray(v) && v.length <= max && v.every((e) => typeof e === "string" && e.length <= maxLen);
	const errArr = (v: unknown, max: number): boolean =>
		Array.isArray(v) &&
		v.length <= max &&
		v.every(
			(e) =>
				typeof e === "object" &&
				e !== null &&
				typeof (e as { tool?: unknown }).tool === "string" &&
				typeof (e as { summary?: unknown }).summary === "string",
		);
	const cmdArr = (v: unknown, max: number): boolean =>
		Array.isArray(v) &&
		v.length <= max &&
		v.every(
			(e) =>
				typeof e === "object" &&
				e !== null &&
				typeof (e as { command?: unknown }).command === "string" &&
				typeof (e as { error?: unknown }).error === "string",
		);
	return (
		d.version === 1 &&
		clean(d.sessionId, 200) &&
		clean(d.cwd, 2000) &&
		clean(d.startedAt, 100) &&
		clean(d.endedAt, 100) &&
		strArr(d.userPrompts, 12, 300) &&
		errArr(d.errors, 20) &&
		cmdArr(d.failedCommands, 20) &&
		typeof d.stopReasons === "object" &&
		d.stopReasons !== null &&
		Object.keys(d.stopReasons).length <= 20 &&
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
	if (fs.existsSync(file)) {
		throw new Error(`skill "${name}" already exists at ${file} — pick a different name or remove it first`);
	}
	fs.mkdirSync(dir, { recursive: true });
	// JSON.stringify produces a valid YAML double-quoted scalar: descriptions
	// with colons, leading dashes, or YAML-reserved words must not break the
	// frontmatter (pi silently skips skills with unparseable frontmatter).
	const content = `---\nname: ${name}\ndescription: ${JSON.stringify(normalizeDescription(description))}\n---\n\n${body.trim()}\n`;
	atomicWrite(file, content);
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
		// A new skill directory bumps the parent's mtime+size, so the cache
		// stays valid until the next write.
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
	// atomicWrite is used for rules, digests, AND skills. Skill tmps live one
	// level deeper: skills/<name>/SKILL.md.*.tmp.
	const dirs = [ouroborosDir(dataDir), digestsDir(dataDir)];
	try {
		for (const name of fs.readdirSync(skillsDir(dataDir))) {
			dirs.push(path.join(skillsDir(dataDir), name));
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
	// "wx" = O_CREAT|O_EXCL: a pre-created symlink at the tmp path fails the
	// open instead of being followed (TOCTOU symlink redirect).
	const fd = fs.openSync(tmp, "wx");
	try {
		fs.writeFileSync(fd, content);
		// fsync before rename: on power loss, ext4 delayed allocation can
		// make the rename durable before the data blocks, leaving an empty
		// file.
		fs.fsyncSync(fd);
	} finally {
		fs.closeSync(fd);
	}
	fs.renameSync(tmp, file);
}

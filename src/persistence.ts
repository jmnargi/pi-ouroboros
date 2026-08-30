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

import * as fs from "node:fs";
import * as path from "node:path";

import type { OuroborosDigest } from "./digest.ts";

export const DEFAULT_RULES_CAP = 50;
export const DEFAULT_RULES_MAX_CHARS = 3000;
export const DEFAULT_REFLECT_MIN_PROMPTS = 5;

export function ouroborosDir(dataDir: string): string {
	return path.join(dataDir, "ouroboros");
}

export function rulesFile(dataDir: string): string {
	return path.join(ouroborosDir(dataDir), "rules.md");
}

export function digestsDir(dataDir: string): string {
	return path.join(ouroborosDir(dataDir), "digests");
}

export function digestFile(dataDir: string, sessionId: string): string {
	return path.join(digestsDir(dataDir), `${sessionId}.json`);
}

export function skillsDir(dataDir: string): string {
	return path.join(dataDir, "skills");
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

/** Load rules as a list of non-empty lines (comments starting with `#` kept). */
export function loadRules(dataDir: string): string[] {
	try {
		const text = fs.readFileSync(rulesFile(dataDir), "utf8");
		return text
			.split("\n")
			.map((l) => l.trim())
			.filter((l) => l.length > 0);
	} catch {
		return [];
	}
}

/**
 * Append a rule, deduped against existing lines. Returns whether it was added
 * and the resulting count. When at cap, the oldest rule is dropped so the
 * freshest lessons always win.
 */
export function appendRule(dataDir: string, rule: string, cap: number = DEFAULT_RULES_CAP): { added: boolean; count: number; cap: number } {
	const normalized = rule.trim().replace(/\s+/g, " ");
	if (!normalized) return { added: false, count: 0, cap };
	const rules = loadRules(dataDir);
	if (rules.includes(normalized)) return { added: false, count: rules.length, cap };
	const next = [...rules, normalized];
	while (next.length > cap) next.shift();
	writeRules(dataDir, next);
	return { added: true, count: next.length, cap };
}

export function clearRules(dataDir: string): void {
	writeRules(dataDir, []);
}

function writeRules(dataDir: string, rules: string[]): void {
	const file = rulesFile(dataDir);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const body = rules.length > 0 ? `${rules.join("\n")}\n` : "";
	atomicWrite(file, body);
}

// ---------------------------------------------------------------------------
// Digests
// ---------------------------------------------------------------------------

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

export function deleteDigest(dataDir: string, sessionId: string): boolean {
	const file = digestFile(dataDir, sessionId);
	if (!fs.existsSync(file)) return false;
	fs.rmSync(file);
	return true;
}

/** Pending digest session ids, newest first (by file mtime). */
export function listDigests(dataDir: string): string[] {
	try {
		const dir = digestsDir(dataDir);
		if (!fs.existsSync(dir)) return [];
		return fs
			.readdirSync(dir)
			.filter((f) => f.endsWith(".json"))
			.map((f) => f.slice(0, -".json".length))
			.sort((a, b) => {
				const ma = fs.statSync(path.join(dir, `${a}.json`)).mtimeMs;
				const mb = fs.statSync(path.join(dir, `${b}.json`)).mtimeMs;
				return mb - ma;
			});
	} catch {
		return [];
	}
}

function isValidDigest(p: unknown): p is OuroborosDigest {
	if (typeof p !== "object" || p === null) return false;
	const d = p as OuroborosDigest;
	return (
		d.version === 1 &&
		typeof d.sessionId === "string" &&
		typeof d.cwd === "string" &&
		Array.isArray(d.userPrompts) &&
		Array.isArray(d.errors) &&
		Array.isArray(d.failedCommands) &&
		typeof d.stopReasons === "object" &&
		d.stopReasons !== null &&
		Array.isArray(d.models) &&
		typeof d.compactions === "number" &&
		typeof d.usage === "object" &&
		d.usage !== null
	);
}

// ---------------------------------------------------------------------------
// Skills
// ---------------------------------------------------------------------------

/** Skill names follow the Agent Skills spec: lowercase letters, digits, hyphens. */
export function isValidSkillName(name: string): boolean {
	return /^[a-z0-9]+(-[a-z0-9]+)*$/.test(name) && name.length <= 64;
}

/** Write a skill and return its SKILL.md path. */
export function writeSkill(dataDir: string, name: string, description: string, body: string): string {
	const dir = path.join(skillsDir(dataDir), name);
	const file = path.join(dir, "SKILL.md");
	fs.mkdirSync(dir, { recursive: true });
	const content = `---\nname: ${name}\ndescription: ${description}\n---\n\n${body.trim()}\n`;
	atomicWrite(file, content);
	return file;
}

/** Names of skills ouroboros has written (directories under the skills dir). */
export function listSkills(dataDir: string): string[] {
	try {
		const dir = skillsDir(dataDir);
		if (!fs.existsSync(dir)) return [];
		return fs
			.readdirSync(dir, { withFileTypes: true })
			.filter((e) => e.isDirectory() && fs.existsSync(path.join(dir, e.name, "SKILL.md")))
			.map((e) => e.name)
			.sort();
	} catch {
		return [];
	}
}

function atomicWrite(file: string, content: string): void {
	const tmp = `${file}.tmp`;
	fs.writeFileSync(tmp, content);
	fs.renameSync(tmp, file);
}

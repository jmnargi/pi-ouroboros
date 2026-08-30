/**
 * Tests for ouroboros disk state (src/persistence.ts).
 */

import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
	appendRule,
	cleanupStaleTmp,
	clearRules,
	deleteDigest,
	deleteInjectedDigest,
	digestFile,
	loadDigest,
	loadRules,
	listDigests,
	listInjectedDigests,
	listSkills,
	saveDigest,
	markDigestInjected,
	normalizeDescription,
	rulesFile,
	safeSessionId,
	unmarkDigestInjected,
	writeSkill,
	isValidSkillName,
} from "../src/persistence.ts";
import { buildDigest } from "../src/digest.ts";

let tmpDirs: string[] = [];

function tmpDataDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ouroboros-test-"));
	tmpDirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of tmpDirs) {
		fs.rmSync(dir, { recursive: true, force: true });
	}
	tmpDirs = [];
});

describe("rules", () => {
	test("appendRule adds, dedupes, and reports counts", async () => {
		const dir = tmpDataDir();
		expect(await appendRule(dir, "Always re-read before editing")).toEqual({ added: true, count: 1, cap: 50 });
		expect(await appendRule(dir, "Always re-read before editing")).toEqual({ added: false, count: 1, cap: 50 });
		expect(await appendRule(dir, "Run tests after refactors")).toEqual({ added: true, count: 2, cap: 50 });
		expect(loadRules(dir)).toEqual(["Always re-read before editing", "Run tests after refactors"]);
	});

	test("appendRule normalizes whitespace and rejects empty", async () => {
		const dir = tmpDataDir();
		expect(await appendRule(dir, "  a   b  ")).toEqual({ added: true, count: 1, cap: 50 });
		expect(loadRules(dir)).toEqual(["a b"]);
		expect((await appendRule(dir, "   ")).added).toBe(false);
	});

	test("appendRule drops the oldest rule at cap", async () => {
		const dir = tmpDataDir();
		for (let i = 0; i < 5; i++) await appendRule(dir, `rule ${i}`);
		expect(loadRules(dir)).toHaveLength(5);
		await appendRule(dir, "rule 5", 5);
		expect(loadRules(dir)).toEqual(["rule 1", "rule 2", "rule 3", "rule 4", "rule 5"]);
	});

	test("appendRule truncates oversized rules and reports real count on empty", async () => {
		const dir = tmpDataDir();
		await appendRule(dir, "keep me");
		const long = "x".repeat(2000);
		expect((await appendRule(dir, long)).added).toBe(true);
		expect(loadRules(dir)[1]).toHaveLength(500);
		expect(await appendRule(dir, "   ")).toEqual({ added: false, count: 2, cap: 50 });
	});

	test("appendRule calls from one turn do not lose rules", async () => {
		const dir = tmpDataDir();
		// The read-modify-write is synchronous, so parallel callers cannot
		// interleave in single-threaded JS — all three rules must survive.
		await Promise.all([appendRule(dir, "rule a"), appendRule(dir, "rule b"), appendRule(dir, "rule c")]);
		expect(loadRules(dir)).toEqual(["rule a", "rule b", "rule c"]);
	});

	test("rules cache picks up external writes and invalidates on own writes", () => {
		const dir = tmpDataDir();
		fs.mkdirSync(path.dirname(rulesFile(dir)), { recursive: true });
		// External write (the model appends directly) — cache must refresh.
		fs.writeFileSync(rulesFile(dir), "- external rule\n");
		expect(loadRules(dir)).toEqual(["- external rule"]);
		// Own write — cache must invalidate.
		appendRule(dir, "own rule");
		expect(loadRules(dir)).toEqual(["- external rule", "own rule"]);
	});

	test("loadRules keeps comment lines and handles empty files", () => {
		const dir = tmpDataDir();
		fs.mkdirSync(path.dirname(rulesFile(dir)), { recursive: true });
		fs.writeFileSync(rulesFile(dir), "# lesson from session X\n");
		expect(loadRules(dir)).toEqual(["# lesson from session X"]);
		fs.writeFileSync(rulesFile(dir), "");
		expect(loadRules(dir)).toEqual([]);
	});

	test("clearRules empties the file", async () => {
		const dir = tmpDataDir();
		await appendRule(dir, "a rule");
		clearRules(dir);
		expect(loadRules(dir)).toEqual([]);
	});

	test("loadRules degrades to empty on unreadable file", () => {
		const dir = tmpDataDir();
		expect(loadRules(dir)).toEqual([]);
		// A directory at the rules path makes readFileSync throw (EISDIR).
		fs.mkdirSync(rulesFile(dir), { recursive: true });
		expect(loadRules(dir)).toEqual([]);
	});
	test("appendRule dedupes semantically (case, punctuation, spacing)", async () => {
		const dir = tmpDataDir();
		await appendRule(dir, "Always re-read before editing!");
		expect(await appendRule(dir, "always re-read before editing")).toEqual({ added: false, count: 1, cap: 50 });
		expect(await appendRule(dir, "ALWAYS  re-read, before editing.")).toEqual({ added: false, count: 1, cap: 50 });
		expect(await appendRule(dir, "Run tests after refactors")).toEqual({ added: true, count: 2, cap: 50 });
	});
	test("appendRule writes through a symlinked rules.md (Data F12)", async () => {
		const dir = tmpDataDir();
		const target = path.join(dir, "linked-rules.md");
		fs.writeFileSync(target, "existing rule\n");
		fs.mkdirSync(path.dirname(rulesFile(dir)), { recursive: true });
		fs.symlinkSync(target, rulesFile(dir));
		await appendRule(dir, "new rule");
		// The symlink must survive and the target must receive the rule.
		expect(fs.lstatSync(rulesFile(dir)).isSymbolicLink()).toBe(true);
		expect(loadRules(dir)).toEqual(["existing rule", "new rule"]);
	});
});
describe("digests", () => {
	const digest = () => buildDigest([], "sess-abc", "/proj", "2026-08-30T12:00:00.000Z");

	test("save/load round-trips and listDigests orders newest first", () => {
		const dir = tmpDataDir();
		const d1 = { ...digest(), sessionId: "sess-1", endedAt: "2026-08-30T10:00:00.000Z" };
		const d2 = { ...digest(), sessionId: "sess-2", endedAt: "2026-08-30T11:00:00.000Z" };
		saveDigest(dir, d1);
		saveDigest(dir, d2);
		// Pin mtimes explicitly — filesystem timestamp granularity varies.
		const now = Date.now() / 1000;
		fs.utimesSync(digestFile(dir, "sess-1"), now - 2, now - 2);
		fs.utimesSync(digestFile(dir, "sess-2"), now - 1, now - 1);
		expect(loadDigest(dir, "sess-1")).toEqual(d1);
		expect(listDigests(dir)).toEqual(["sess-2", "sess-1"]);
	});

	test("deleteDigest removes and reports existence", () => {
		const dir = tmpDataDir();
		saveDigest(dir, digest());
		expect(deleteDigest(dir, "sess-abc")).toBe(true);
		expect(deleteDigest(dir, "sess-abc")).toBe(false);
		expect(listDigests(dir)).toEqual([]);
	});

	test("loadDigest rejects corrupt files", () => {
		const dir = tmpDataDir();
		const file = digestFile(dir, "sess-bad");
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, "{ not json");
		expect(loadDigest(dir, "sess-bad")).toBeNull();
	});

	test("safeSessionId hashes distinct unsafe ids distinctly (Data F5)", () => {
		// The old djb2 hash collided at ~77k ids; sha256-16hex does not.
		expect(safeSessionId("sess-5s5-5edxhisd")).not.toBe(safeSessionId("sess-vp5-wbt0rpm4"));
		// Hashed ids live in their own namespace, never colliding with
		// verbatim safe ids.
		expect(safeSessionId("../../etc/passwd")).toMatch(/^sid-h-[0-9a-f]{16}$/);
		expect(safeSessionId("sid-h-3754d6cb3a38e118")).toBe("sid-h-3754d6cb3a38e118");
	});

	test("listDigests skips unstatable files instead of failing (Data F3)", () => {
		const dir = tmpDataDir();
		saveDigest(dir, digest());
		const digests = path.dirname(digestFile(dir, "x"));
		fs.symlinkSync("/nonexistent-target", path.join(digests, "broken.json"));
		expect(listDigests(dir)).toEqual(["sess-abc"]);
	});

	test("loadDigest rejects absurd values (Data F8)", () => {
		const dir = tmpDataDir();
		const file = digestFile(dir, "sess-absurd");
		fs.mkdirSync(path.dirname(file), { recursive: true });
		const base = digest();
		fs.writeFileSync(file, JSON.stringify({ ...base, messageCount: -5 }));
		expect(loadDigest(dir, "sess-absurd")).toBeNull();
		fs.writeFileSync(file, JSON.stringify({ ...base, usage: { input: 0, output: 0, cost: -1 } }));
		expect(loadDigest(dir, "sess-absurd")).toBeNull();
		fs.writeFileSync(file, JSON.stringify({ ...base, stopReasons: { length: "x" } }));
		expect(loadDigest(dir, "sess-absurd")).toBeNull();
		fs.writeFileSync(file, JSON.stringify({ ...base, sessionId: "bad\u0000id" }));
		expect(loadDigest(dir, "sess-absurd")).toBeNull();
	});

	test("cleanupStaleTmp removes old tmp files and keeps fresh ones", () => {
		const dir = tmpDataDir();
		const ouroboros = path.join(dir, "ouroboros");
		fs.mkdirSync(ouroboros, { recursive: true });
		const stale = path.join(ouroboros, "rules.md.123.456.0.tmp");
		const fresh = path.join(ouroboros, "rules.md.999.999.0.tmp");
		fs.writeFileSync(stale, "x");
		fs.writeFileSync(fresh, "y");
		const old = Date.now() / 1000 - 7200;
		fs.utimesSync(stale, old, old);
		cleanupStaleTmp(dir);
		expect(fs.existsSync(stale)).toBe(false);
		expect(fs.existsSync(fresh)).toBe(true);
	});



	test("listDigests ignores non-json files and missing dir", () => {
		const dir = tmpDataDir();
		expect(listDigests(dir)).toEqual([]);
		saveDigest(dir, digest());
		fs.writeFileSync(path.join(path.dirname(digestFile(dir, "x")), "notes.txt"), "hi");
		expect(listDigests(dir)).toEqual(["sess-abc"]);
	});

	test("safeSessionId neutralizes path traversal", () => {
		expect(safeSessionId("01a05380-28c8-7dad-8e5b-165ba08ccd7a")).toBe("01a05380-28c8-7dad-8e5b-165ba08ccd7a");
		expect(safeSessionId("../../etc/passwd")).not.toContain("..");
		expect(safeSessionId("../../etc/passwd")).not.toContain("/");
		expect(digestFile("/tmp", "../../etc/passwd")).not.toContain("..");
	});

	test("injected digests are marked, listed, unmarked, and deleted", () => {
		const dir = tmpDataDir();
		saveDigest(dir, digest());
		expect(markDigestInjected(dir, "sess-abc")).toBe(true);
		expect(listDigests(dir)).toEqual([]); // no longer pending
		expect(listInjectedDigests(dir)).toEqual(["sess-abc"]);
		// Unmark restores the pending digest (sendMessage-failure path).
		expect(unmarkDigestInjected(dir, "sess-abc")).toBe(true);
		expect(listDigests(dir)).toEqual(["sess-abc"]);
		expect(listInjectedDigests(dir)).toEqual([]);
		expect(markDigestInjected(dir, "sess-abc")).toBe(true);
		expect(deleteInjectedDigest(dir, "sess-abc")).toBe(true);
		expect(listInjectedDigests(dir)).toEqual([]);
		expect(markDigestInjected(dir, "sess-abc")).toBe(false); // already gone
	});
});


describe("skills", () => {
	test("isValidSkillName enforces the Agent Skills spec", () => {
		expect(isValidSkillName("debug-flaky-tests")).toBe(true);
		expect(isValidSkillName("a1-b2")).toBe(true);
		expect(isValidSkillName("Bad Name")).toBe(false);
		expect(isValidSkillName("-leading")).toBe(false);
		expect(isValidSkillName("double--hyphen")).toBe(false);
		expect(isValidSkillName("")).toBe(false);
		expect(isValidSkillName("x".repeat(65))).toBe(false);
	});

	test("writeSkill writes frontmatter and listSkills discovers it", () => {
		const dir = tmpDataDir();
		const file = writeSkill(dir, "debug-flaky-tests", "Find and fix flaky tests", "## Steps\n\n1. Run the test 10x\n2. Look for timing");
		expect(file.endsWith(path.join("skills", "debug-flaky-tests", "SKILL.md"))).toBe(true);
		const content = fs.readFileSync(file, "utf8");
		expect(content).toContain("name: debug-flaky-tests");
		expect(content).toContain('description: "Find and fix flaky tests"');
		expect(content).toContain("## Steps");
		expect(listSkills(dir)).toEqual(["debug-flaky-tests"]);
	});

	test("writeSkill refuses to overwrite an existing skill (Data F1)", () => {
		const dir = tmpDataDir();
		writeSkill(dir, "debug-flaky-tests", "first", "body one");
		expect(() => writeSkill(dir, "debug-flaky-tests", "second", "body two")).toThrow(/already exists/);
		// The original content is untouched.
		expect(fs.readFileSync(path.join(dir, "skills", "debug-flaky-tests", "SKILL.md"), "utf8")).toContain("body one");
	});
	test("writeSkill quotes descriptions with YAML-reserved characters", () => {
		const dir = tmpDataDir();
		writeSkill(dir, "yaml-true", "true", "body");
		writeSkill(dir, "yaml-quote", 'say "hi" now', "body");
		writeSkill(dir, "yaml-dash", "- leading dash", "body");
		writeSkill(dir, "yaml-colon", "Fix flaky tests: run them 10 times", "body");
		const trueContent = fs.readFileSync(path.join(dir, "skills", "yaml-true", "SKILL.md"), "utf8");
		const quoteContent = fs.readFileSync(path.join(dir, "skills", "yaml-quote", "SKILL.md"), "utf8");
		const dashContent = fs.readFileSync(path.join(dir, "skills", "yaml-dash", "SKILL.md"), "utf8");
		const colonContent = fs.readFileSync(path.join(dir, "skills", "yaml-colon", "SKILL.md"), "utf8");
		expect(trueContent).toContain('description: "true"');
		expect(quoteContent).toContain('description: "say \\"hi\\" now"');
		expect(dashContent).toContain('description: "- leading dash"');
		expect(colonContent).toContain('description: "Fix flaky tests: run them 10 times"');
	});

	test("listSkills ignores dirs without SKILL.md", () => {
		const dir = tmpDataDir();
		fs.mkdirSync(path.join(dir, "skills", "empty"), { recursive: true });
		expect(listSkills(dir)).toEqual([]);
	});
});

describe("normalizeDescription", () => {
	test("collapses newlines and whitespace to a single line", () => {
		expect(normalizeDescription("Run the test suite\nafter any refactor")).toBe("Run the test suite after any refactor");
		expect(normalizeDescription("  a   b  ")).toBe("a b");
		expect(normalizeDescription("---\nname: other\n---")).toBe("--- name: other ---");
	});
});

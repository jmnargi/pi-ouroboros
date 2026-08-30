/**
 * Tests for ouroboros disk state (src/persistence.ts).
 */

import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
	appendRule,
	clearRules,
	deleteDigest,
	deleteInjectedDigest,
	digestFile,
	loadDigest,
	loadRules,
	listDigests,
	listInjectedDigests,
	listSkills,
	markDigestInjected,
	normalizeDescription,
	rulesFile,
	safeSessionId,
	saveDigest,
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
	test("appendRule adds, dedupes, and reports counts", () => {
		const dir = tmpDataDir();
		expect(appendRule(dir, "Always re-read before editing")).toEqual({ added: true, count: 1, cap: 50 });
		expect(appendRule(dir, "Always re-read before editing")).toEqual({ added: false, count: 1, cap: 50 });
		expect(appendRule(dir, "Run tests after refactors")).toEqual({ added: true, count: 2, cap: 50 });
		expect(loadRules(dir)).toEqual(["Always re-read before editing", "Run tests after refactors"]);
	});

	test("appendRule normalizes whitespace and rejects empty", () => {
		const dir = tmpDataDir();
		expect(appendRule(dir, "  a   b  ")).toEqual({ added: true, count: 1, cap: 50 });
		expect(loadRules(dir)).toEqual(["a b"]);
		expect(appendRule(dir, "   ").added).toBe(false);
	});

	test("appendRule drops the oldest rule at cap", () => {
		const dir = tmpDataDir();
		for (let i = 0; i < 5; i++) appendRule(dir, `rule ${i}`);
		expect(loadRules(dir)).toHaveLength(5);
		appendRule(dir, "rule 5", 5);
		expect(loadRules(dir)).toEqual(["rule 1", "rule 2", "rule 3", "rule 4", "rule 5"]);
	});

	test("appendRule truncates oversized rules and reports real count on empty", () => {
		const dir = tmpDataDir();
		appendRule(dir, "keep me");
		const long = "x".repeat(2000);
		expect(appendRule(dir, long).added).toBe(true);
		expect(loadRules(dir)[1]).toHaveLength(500);
		expect(appendRule(dir, "   ")).toEqual({ added: false, count: 2, cap: 50 });
	});

	test("clearRules empties the file", () => {
		const dir = tmpDataDir();
		appendRule(dir, "a rule");
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
});

describe("digests", () => {
	const digest = () => buildDigest([], "sess-abc", "/proj", "2026-08-30T12:00:00.000Z");

	test("save/load round-trips and listDigests orders newest first", () => {
		const dir = tmpDataDir();
		const d1 = { ...digest(), sessionId: "sess-1", endedAt: "2026-08-30T10:00:00.000Z" };
		const d2 = { ...digest(), sessionId: "sess-2", endedAt: "2026-08-30T11:00:00.000Z" };
		saveDigest(dir, d1);
		saveDigest(dir, d2);
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

	test("injected digests are marked, listed, and deleted separately", () => {
		const dir = tmpDataDir();
		saveDigest(dir, digest());
		expect(markDigestInjected(dir, "sess-abc")).toBe(true);
		expect(listDigests(dir)).toEqual([]); // no longer pending
		expect(listInjectedDigests(dir)).toEqual(["sess-abc"]);
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
		expect(content).toContain("description: Find and fix flaky tests");
		expect(content).toContain("## Steps");
		expect(listSkills(dir)).toEqual(["debug-flaky-tests"]);
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

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
	lastDigestFile,
	loadDigest,
	isValidDigest,
	readInjectedDigest,
	loadLastDigest,
	loadRules,
	listDigests,
	listInjectedDigests,
	listSkills,
	saveDigest,
	saveLastDigest,
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
		expect(await appendRule(dir, "Always re-read before editing")).toEqual({ added: true, reason: "added", count: 1, cap: 50 });
		expect(await appendRule(dir, "Always re-read before editing")).toEqual({ added: false, reason: "duplicate", count: 1, cap: 50 });
		expect(await appendRule(dir, "Run tests after refactors")).toEqual({ added: true, reason: "added", count: 2, cap: 50 });
		expect(loadRules(dir)).toEqual(["Always re-read before editing", "Run tests after refactors"]);
	});

	test("appendRule normalizes whitespace and rejects empty", async () => {
		const dir = tmpDataDir();
		expect(await appendRule(dir, "  a   b  ")).toEqual({ added: true, reason: "added", count: 1, cap: 50 });
		expect(loadRules(dir)).toEqual(["a b"]);
		expect((await appendRule(dir, "   ")).added).toBe(false);
	});
	test("appendRule rejects lessons with no letter or number content (EdgeCases)", async () => {
		const dir = tmpDataDir();
		// '!!!' and emoji-only are not lessons — and they share the empty
		// dedupKey, so the first would shadow all later ones as 'duplicate'.
		expect((await appendRule(dir, "!!!")).reason).toBe("empty");
		expect((await appendRule(dir, "😀😀")).reason).toBe("empty");
		expect(loadRules(dir)).toEqual([]);
		// CJK lessons are letters — the model may write in any language.
		expect((await appendRule(dir, "編集前にファイルを再読込する")).added).toBe(true);
		expect(loadRules(dir)).toEqual(["編集前にファイルを再読込する"]);
		// A SECOND distinct CJK rule must not be shadowed by the empty
		// dedupKey (Security6: only one non-Latin rule could be stored).
		expect((await appendRule(dir, "テストを実行する")).added).toBe(true);
		expect(loadRules(dir)).toEqual(["編集前にファイルを再読込する", "テストを実行する"]);
		// A near-duplicate CJK rule (punctuation differs) is still deduped.
		expect((await appendRule(dir, "編集前にファイルを再読込する！")).reason).toBe("duplicate");
	});
	test("appendRule cuts by code points, never storing a lone surrogate (Security8)", async () => {
		const dir = tmpDataDir();
		// 499 ASCII chars + an emoji is 500 code points / 501 units: a
		// UTF-16 slice at 500 would split the pair. The stored rule must
		// keep the emoji intact and contain no lone surrogate.
		const rule = "x".repeat(499) + "😀";
		expect((await appendRule(dir, rule)).added).toBe(true);
		const stored = loadRules(dir)[0]!;
		expect([...stored]).toHaveLength(500);
		expect(stored.endsWith("😀")).toBe(true);
		expect([...stored].some((c) => c.length === 1 && c.charCodeAt(0) >= 0xd800 && c.charCodeAt(0) <= 0xdfff)).toBe(false);
	});
	test("loadRules passes through U+FFFD; the lone-surrogate strip is defense-in-depth (Security8)", async () => {
		const dir = tmpDataDir();
		fs.mkdirSync(path.dirname(rulesFile(dir)), { recursive: true });
		// A lone surrogate written to a UTF-8 file becomes U+FFFD (Node's
		// encoder cannot represent it), so the strip cannot be exercised
		// through normal file IO — it guards non-UTF-8 files. Normal rules
		// pass through unchanged.
		fs.writeFileSync(rulesFile(dir), "fix \ud800 the bug\n");
		expect(loadRules(dir)).toEqual(["fix \ufffd the bug"]);
	});

	test("appendRule drops the oldest rule at cap", async () => {
		const dir = tmpDataDir();
		for (let i = 0; i < 5; i++) await appendRule(dir, `rule ${i}`);
		expect(loadRules(dir)).toHaveLength(5);
		await appendRule(dir, "rule 5", 5);
		expect(loadRules(dir)).toEqual(["rule 1", "rule 2", "rule 3", "rule 4", "rule 5"]);
	});

	test("appendRule evicts by characters so every rule fits the appendix budget", async () => {
		const dir = tmpDataDir();
		// 3 rules of ~40 chars each exceed a 100-char budget.
		await appendRule(dir, "a".repeat(40), 50, 100);
		await appendRule(dir, "b".repeat(40), 50, 100);
		await appendRule(dir, "c".repeat(40), 50, 100);
		const rules = loadRules(dir);
		expect(rules.join("\n").length + 1).toBeLessThanOrEqual(100);
		// The newest rule survives; the oldest is evicted.
		expect(rules[rules.length - 1]).toBe("c".repeat(40));
	});
	test("appendRule truncates oversized rules and reports real count on empty", async () => {
		const dir = tmpDataDir();
		await appendRule(dir, "keep me");
		const long = "x".repeat(2000);
		expect((await appendRule(dir, long)).added).toBe(true);
		expect(loadRules(dir)[1]).toHaveLength(500);
		expect(await appendRule(dir, "   ")).toEqual({ added: false, reason: "empty", count: 2, cap: 50 });
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
	test("rulesMissing negative cache is keyed by file path and cleared by writes", () => {
		const dir1 = tmpDataDir();
		const dir2 = tmpDataDir();
		// dir1's rules are missing — the negative cache records dir1's path.
		expect(loadRules(dir1)).toEqual([]);
		// dir2 has rules. A GLOBAL negative cache would return [] from dir1's
		// entry; the keyed cache re-stats dir2 and returns its rules.
		fs.mkdirSync(path.dirname(rulesFile(dir2)), { recursive: true });
		fs.writeFileSync(rulesFile(dir2), "- dir2 rule\n");
		expect(loadRules(dir2)).toEqual(["- dir2 rule"]);
		// appendRule clears the negative cache: dir1's rules now exist.
		appendRule(dir1, "own rule");
		expect(loadRules(dir1)).toEqual(["own rule"]);
	});
	test("appendRule dedupes semantically (case, punctuation, spacing)", async () => {
		const dir = tmpDataDir();
		await appendRule(dir, "Always re-read before editing!");
		expect(await appendRule(dir, "always re-read before editing")).toEqual({ added: false, reason: "duplicate", count: 1, cap: 50 });
		expect(await appendRule(dir, "ALWAYS  re-read, before editing.")).toEqual({ added: false, reason: "duplicate", count: 1, cap: 50 });
		expect(await appendRule(dir, "Run tests after refactors")).toEqual({ added: true, reason: "added", count: 2, cap: 50 });
	});

	test("appendRule strips control characters (SEC-001)", async () => {
		const dir = tmpDataDir();
		await appendRule(dir, "always\u0000 re-read\u0007 before editing");
		expect(loadRules(dir)).toEqual(["always re-read before editing"]);
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
	test("a symlinked digests dir is never read or deleted through (Security9)", () => {
		const dir = tmpDataDir();
		// A symlinked digests dir pointing at a victim directory: the
		// plugin must not list, read, or delete the victim's *.json files.
		const victim = fs.mkdtempSync(path.join(os.tmpdir(), "ouroboros-victim-"));
		tmpDirs.push(victim);
		fs.writeFileSync(path.join(victim, "package.json"), "{}");
		fs.mkdirSync(path.join(dir, "ouroboros"), { recursive: true });
		fs.symlinkSync(victim, path.join(dir, "ouroboros", "digests"));
		expect(listDigests(dir)).toEqual([]);
		expect(listInjectedDigests(dir)).toEqual([]);
		expect(deleteDigest(dir, "package")).toBe(false);
		expect(fs.existsSync(path.join(victim, "package.json"))).toBe(true);
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
		// Hashed names are idempotent: a sid-h-<16hex> id is already safe
		// (needed so loadDigest finds files saved for dot-containing ids).
		expect(safeSessionId("../../etc/passwd")).toMatch(/^sid-h-[0-9a-f]{16}$/);
		expect(safeSessionId("sid-h-3754d6cb3a38e118")).toBe("sid-h-3754d6cb3a38e118");
	});

	test("listDigests lists hashed names from dot-containing session ids", () => {
		const dir = tmpDataDir();
		// A session id with a dot is hashed to sid-h-<16hex>.json; the
		// round-trip filter must accept it (it does not round-trip).
		const hashed = safeSessionId("my.session");
		expect(hashed).toMatch(/^sid-h-[0-9a-f]{16}$/);
		saveDigest(dir, { ...digest(), sessionId: "my.session" });
		expect(listDigests(dir)).toEqual([hashed]);
		expect(loadDigest(dir, hashed)).not.toBeNull();
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
		// A control char in a header field is REPAIRED by migration (the
		// round-7 writer stored header fields raw) — the digest loads with
		// the char stripped, so the reflection is not lost.
		fs.writeFileSync(file, JSON.stringify({ ...base, sessionId: "bad\u0000id" }));
		expect(loadDigest(dir, "sess-absurd")?.sessionId).toBe("badid");
		// Element shape: a junk failedCommands element is rejected.
		fs.writeFileSync(file, JSON.stringify({ ...base, failedCommands: [{ command: 42, error: "x" }] }));
		expect(loadDigest(dir, "sess-absurd")).toBeNull();
	});

	test("migrates legacy digests on load (upgrade path)", () => {
		const dir = tmpDataDir();
		const file = digestFile(dir, "sess-legacy");
		fs.mkdirSync(path.dirname(file), { recursive: true });
		// Non-empty userPrompts so the derived userPromptCount is meaningful
		// (a vacuous 0 === 0 would pass even if migrateDigest hardcoded 0).
		const base = buildDigest(
			[
				{ type: "session", id: "sess-legacy", cwd: "/proj", timestamp: "2026-08-30T10:00:00.000Z" },
				{ type: "message", message: { role: "user", content: "fix the bug" } },
				{ type: "message", message: { role: "user", content: "now the tests" } },
			],
			"sess-legacy",
			"/proj",
			"2026-08-30T12:00:00.000Z",
		);
		expect(base.userPrompts).toHaveLength(2);
		// Round-3 shape: no userPromptCount.
		const { userPromptCount: _drop, ...round3 } = base as unknown as Record<string, unknown>;
		fs.writeFileSync(file, JSON.stringify(round3));
		const migrated = loadDigest(dir, "sess-legacy");
		expect(migrated).not.toBeNull();
		expect(migrated!.userPromptCount).toBe(2);
		// Round-1/2 shape: failedCommands is a string[].
		fs.writeFileSync(file, JSON.stringify({ ...round3, failedCommands: ["npm test", "ls /x"] }));
		const migrated2 = loadDigest(dir, "sess-legacy");
		expect(migrated2).not.toBeNull();
		expect(migrated2!.failedCommands).toEqual([
			{ command: "npm test", error: "" },
			{ command: "ls /x", error: "" },
		]);
	});
	test("migrateDigest sanitizes round-7 digests with dirty fields (Concurrency3)", () => {
		const dir = tmpDataDir();
		const file = digestFile(dir, "sess-legacy");
		fs.mkdirSync(path.dirname(file), { recursive: true });
		const base = digest();
		// Round-7 writer output: raw stopReason key with a tab, raw model
		// string with ESC, 25 models (unbounded), raw error tool name.
		const round7 = {
			...base,
			stopReasons: { "stop\treason": 1 },
			models: ["vitruvix\u001bcode", ...Array.from({ length: 25 }, (_, i) => `model-${i}`)],
			errors: [{ tool: "edit\u2028evil", summary: "boom" }],
		};
		fs.writeFileSync(file, JSON.stringify(round7));
		const migrated = loadDigest(dir, "sess-legacy");
		expect(migrated).not.toBeNull();
		expect(migrated!.stopReasons).toEqual({ stopreason: 1 });
		expect(migrated!.models).toHaveLength(20);
		expect(migrated!.models[0]).toBe("vitruvixcode");
		expect(migrated!.errors[0]!.tool).toBe("editevil");
	});
	test("over-bounded arrays stay rejected after migration (TestQuality3)", () => {
		const dir = tmpDataDir();
		const file = digestFile(dir, "sess-legacy");
		fs.mkdirSync(path.dirname(file), { recursive: true });
		const base = digest();
		// No writer ever produced a 13-element userPrompts (PROMPT_CAP=12) —
		// it is corruption. migrateDigest must NOT re-bound it; the
		// validator's length check rejects the digest.
		fs.writeFileSync(file, JSON.stringify({ ...base, userPrompts: Array.from({ length: 13 }, (_, i) => `p${i}`) }));
		expect(loadDigest(dir, "sess-legacy")).toBeNull();
	});
	test("migrateDigest cuts by code points, never splitting a surrogate pair (TestQuality3)", () => {
		const dir = tmpDataDir();
		const file = digestFile(dir, "sess-legacy");
		fs.mkdirSync(path.dirname(file), { recursive: true });
		const base = digest();
		// A round-7 error tool name with an astral char at the 100-code-point
		// boundary: a UTF-16 slice would split the surrogate pair.
		const round7 = { ...base, errors: [{ tool: "x".repeat(99) + "😀" + "y", summary: "boom" }] };
		fs.writeFileSync(file, JSON.stringify(round7));
		const migrated = loadDigest(dir, "sess-legacy");
		expect(migrated).not.toBeNull();
		const tool = migrated!.errors[0]!.tool;
		expect([...tool]).toHaveLength(100); // 100 code points
		expect(tool.endsWith("😀")).toBe(true); // the pair survives intact
		// A lone surrogate is a single UTF-16 unit in the range; a full
		// astral code point is two units (its charCodeAt(0) is the high
		// surrogate and must NOT count).
		expect([...tool].some((c) => c.length === 1 && c.charCodeAt(0) >= 0xd800 && c.charCodeAt(0) <= 0xdfff)).toBe(false);
	});
	test("migrateDigest repairs dirty header fields (FixAudit8/Lifecycle2)", () => {
		const dir = tmpDataDir();
		const file = digestFile(dir, "sess-legacy");
		fs.mkdirSync(path.dirname(file), { recursive: true });
		const base = digest();
		// The round-7 writer stored header fields RAW: a control char in
		// cwd must be repaired, not rejected (rejection deletes the digest
		// and loses the reflection).
		fs.writeFileSync(file, JSON.stringify({ ...base, cwd: "/proj\u0007evil", sessionId: "sess\u200b-legacy" }));
		const migrated = loadDigest(dir, "sess-legacy");
		expect(migrated).not.toBeNull();
		expect(migrated!.cwd).toBe("/projevil");
		expect(migrated!.sessionId).toBe("sess-legacy");
	});
	test("migrateDigest cuts toolCalls[].tool by code points (FixAudit8)", () => {
		const dir = tmpDataDir();
		const file = digestFile(dir, "sess-legacy");
		fs.mkdirSync(path.dirname(file), { recursive: true });
		const base = digest();
		// A round-6/7 tool name longer than 100 code points must be cut,
		// not rejected (rejection deletes the digest).
		const round7 = { ...base, toolCalls: [{ tool: "x".repeat(99) + "😀" + "y", args: "{}" }] };
		fs.writeFileSync(file, JSON.stringify(round7));
		const migrated = loadDigest(dir, "sess-legacy");
		expect(migrated).not.toBeNull();
		expect([...migrated!.toolCalls[0]!.tool]).toHaveLength(100);
		expect(migrated!.toolCalls[0]!.tool.endsWith("😀")).toBe(true);
	});
	test("a digest with more than 20 stopReasons keys is rejected (FixAudit9)", () => {
		// migrateDigest re-caps legacy digests at 20, so this exercises the
		// validator directly — the last line of defense against a crafted
		// digest that bypasses migration.
		const base = digest();
		const stops: Record<string, number> = {};
		for (let i = 0; i < 21; i++) stops[`stop-${i}`] = 1;
		expect(isValidDigest({ ...base, stopReasons: stops })).toBe(false);
		// 20 keys is the writer's cap and must pass.
		const stops20: Record<string, number> = {};
		for (let i = 0; i < 20; i++) stops20[`stop-${i}`] = 1;
		expect(isValidDigest({ ...base, stopReasons: stops20 })).toBe(true);
	});
	test("cleanupStaleTmp does not follow a symlinked ouroboros dir (Security8)", () => {
		const dir = tmpDataDir();
		// A symlinked ouroboros dir pointing at a directory with an old
		// tmp file: the cleanup must not delete inside the target.
		const target = fs.mkdtempSync(path.join(os.tmpdir(), "ouroboros-target-"));
		tmpDirs.push(target);
		const oldTmp = path.join(target, "victim.tmp");
		fs.writeFileSync(oldTmp, "x");
		const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
		fs.utimesSync(oldTmp, old, old);
		fs.symlinkSync(target, path.join(dir, "ouroboros"));
		cleanupStaleTmp(dir);
		expect(fs.existsSync(oldTmp)).toBe(true);
	});
	test("an array-typed stopReasons stays rejected (Security7)", () => {
		const dir = tmpDataDir();
		const file = digestFile(dir, "sess-legacy");
		fs.mkdirSync(path.dirname(file), { recursive: true });
		const base = digest();
		// An array is the one wrong shape that satisfies typeof object —
		// migrateDigest must leave it for the validator to reject.
		fs.writeFileSync(file, JSON.stringify({ ...base, stopReasons: [] }));
		expect(loadDigest(dir, "sess-legacy")).toBeNull();
	});
	test("a lone surrogate in a legacy field is repaired, not rejected (Security7)", () => {
		const dir = tmpDataDir();
		const file = digestFile(dir, "sess-legacy");
		fs.mkdirSync(path.dirname(file), { recursive: true });
		const base = digest();
		// A legacy UTF-16 slice artifact: the migration strips the lone
		// surrogate so the digest loads and the reflection is not lost.
		fs.writeFileSync(file, JSON.stringify({ ...base, userPrompts: ["fix \ud800 the bug"] }));
		const migrated = loadDigest(dir, "sess-legacy");
		expect(migrated).not.toBeNull();
		expect(migrated!.userPrompts[0]).toBe("fix  the bug");
	});
	test("a transient IO error keeps the digest file (Security7)", () => {
		const dir = tmpDataDir();
		const file = digestFile(dir, "sess-io");
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, JSON.stringify(digest()));
		// A directory at the digest path makes readFileSync fail with EISDIR
		// (an IO error, not corruption) — the loader must throw, not return
		// null, so the caller keeps the file instead of deleting it.
		fs.rmSync(file);
		fs.mkdirSync(file);
		expect(() => loadDigest(dir, "sess-io")).toThrow();
		expect(fs.existsSync(file)).toBe(true);
	});
	test("readInjectedDigest throws on IO errors, keeping the marker (TestQuality4)", () => {
		const dir = tmpDataDir();
		const file = `${digestFile(dir, "sess-io").slice(0, -".json".length)}.injected.json`;
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, JSON.stringify(digest()));
		// A directory at the marker path makes readFileSync fail with EISDIR
		// — the loader must throw (not return null), so the caller keeps the
		// marker instead of deleting it.
		fs.rmSync(file);
		fs.mkdirSync(file);
		expect(() => readInjectedDigest(dir, "sess-io")).toThrow();
		expect(fs.existsSync(file)).toBe(true);
	});
	test("listInjectedDigests skips non-round-tripping stems (Security7)", () => {
		const dir = tmpDataDir();
		const digests = path.join(dir, "ouroboros", "digests");
		fs.mkdirSync(digests, { recursive: true });
		fs.writeFileSync(path.join(digests, "a.b.injected.json"), "{}");
		fs.writeFileSync(path.join(digests, "sess-ok.injected.json"), "{}");
		expect(listInjectedDigests(dir)).toEqual(["sess-ok"]);
	});
	test("cleanupStaleTmp does not follow symlinked skill dirs (Security7)", () => {
		const dir = tmpDataDir();
		// cleanupStaleTmp scans skillsDir(dataDir) = <dataDir>/skills.
		const skills = path.join(dir, "skills");
		fs.mkdirSync(skills, { recursive: true });
		// A symlinked skill dir pointing at a directory with an old tmp
		// file: the cleanup must not delete inside the target.
		const target = fs.mkdtempSync(path.join(os.tmpdir(), "ouroboros-target-"));
		tmpDirs.push(target);
		const oldTmp = path.join(target, "victim.tmp");
		fs.writeFileSync(oldTmp, "x");
		const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
		fs.utimesSync(oldTmp, old, old);
		fs.symlinkSync(target, path.join(skills, "evil"));
		cleanupStaleTmp(dir);
		expect(fs.existsSync(oldTmp)).toBe(true);
	});
	test("cleanupStaleTmp does not follow a symlinked ouroboros dir with a digests subdir (FixAudit10)", () => {
		const dir = tmpDataDir();
		// The target has a REAL digests subdir with an old tmp: the
		// digests-dir lstat would resolve inside the symlink target and
		// delete it. The ouroboros-dir check must gate the digests scan.
		const target = fs.mkdtempSync(path.join(os.tmpdir(), "ouroboros-target-"));
		tmpDirs.push(target);
		fs.mkdirSync(path.join(target, "digests"), { recursive: true });
		const oldTmp = path.join(target, "digests", "victim.tmp");
		fs.writeFileSync(oldTmp, "x");
		const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
		fs.utimesSync(oldTmp, old, old);
		fs.symlinkSync(target, path.join(dir, "ouroboros"));
		cleanupStaleTmp(dir);
		expect(fs.existsSync(oldTmp)).toBe(true);
	});
	test("writeSkill re-throws a non-EEXIST link error and cleans its tmp (TestQuality4)", () => {
		const dir = tmpDataDir();
		// A directory at the SKILL.md path makes linkSync fail with EPERM
		// on Linux. The fallback's openSync(file, "wx") then fails with
		// EEXIST (the directory exists) — the friendly 'already exists'
		// error proves the fallback ran (a revert would re-throw the raw
		// EPERM instead).
		const skillDir = path.join(dir, "skills", "my-skill");
		fs.mkdirSync(path.join(skillDir, "SKILL.md"), { recursive: true });
		expect(() => writeSkill(dir, "my-skill", "desc", "body")).toThrow(/already exists/);
		expect(fs.readdirSync(skillDir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
	});
	test("writeSkill refuses to overwrite atomically (Security7)", () => {
		// The no-overwrite contract is pinned here; the atomicity property
		// (two concurrent writers cannot both pass the check) is verified
		// by code inspection — the link is the atomic claim.
		const dir = tmpDataDir();
		writeSkill(dir, "my-skill", "desc", "body");
		// A second write with the same name must fail even though the
		// existsSync pre-check is gone (the link is the atomic claim).
		expect(() => writeSkill(dir, "my-skill", "desc2", "body2")).toThrow(/already exists/);
		const content = fs.readFileSync(path.join(dir, "skills", "my-skill", "SKILL.md"), "utf8");
		expect(content).toContain("desc");
		expect(content).not.toContain("desc2");
		// No leftover tmp files after the EEXIST throw.
		expect(fs.readdirSync(path.join(dir, "skills", "my-skill")).filter((f) => f.endsWith(".tmp"))).toEqual([]);
	});
	test("writeSkill re-throws a non-EEXIST link error and cleans its tmp (TestQuality4)", () => {
		const dir = tmpDataDir();
		// A directory at the SKILL.md path makes linkSync fail with EPERM
		// on Linux. The fallback's openSync(file, "wx") then fails with
		// EEXIST (the directory exists) — the friendly 'already exists'
		// error proves the fallback ran (a revert would re-throw the raw
		// EPERM instead).
		const skillDir = path.join(dir, "skills", "my-skill");
		fs.mkdirSync(path.join(skillDir, "SKILL.md"), { recursive: true });
		expect(() => writeSkill(dir, "my-skill", "desc", "body")).toThrow(/already exists/);
		expect(fs.readdirSync(skillDir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
	});

	test("last digest round-trips for /ouroboros digest (UX-2)", () => {
		const dir = tmpDataDir();
		expect(loadLastDigest(dir)).toBeNull();
		const d = digest();
		saveLastDigest(dir, d);
		expect(loadLastDigest(dir)).toEqual(d);
	});
	test("loadLastDigest migrates legacy digests too (FixAudit3 P2)", () => {
		const dir = tmpDataDir();
		const file = lastDigestFile(dir);
		fs.mkdirSync(path.dirname(file), { recursive: true });
		const base = digest();
		// Round-4 shape: no toolCalls/assistantText, string[] failedCommands.
		const { toolCalls: _t, assistantText: _a, ...round4 } = base as unknown as Record<string, unknown>;
		fs.writeFileSync(file, JSON.stringify({ ...round4, failedCommands: ["npm test"] }));
		const migrated = loadLastDigest(dir);
		expect(migrated).not.toBeNull();
		expect(migrated!.toolCalls).toEqual([]);
		expect(migrated!.assistantText).toEqual([]);
		expect(migrated!.failedCommands).toEqual([{ command: "npm test", error: "" }]);
	});
	test("migration edge cases: string userPromptCount migrates, junk failedCommands rejected", () => {
		const dir = tmpDataDir();
		const file = digestFile(dir, "sess-edge");
		fs.mkdirSync(path.dirname(file), { recursive: true });
		const base = digest();
		// userPromptCount: "x" is not a number — migrateDigest derives it
		// from userPrompts (a migration, not a rejection).
		fs.writeFileSync(file, JSON.stringify({ ...base, userPromptCount: "x" }));
		const migrated = loadDigest(dir, "sess-edge");
		expect(migrated).not.toBeNull();
		expect(migrated!.userPromptCount).toBe(base.userPrompts.length);
		// failedCommands: [42] is neither string[] nor {command,error}[] —
		// migrateDigest leaves it, isValidDigest rejects it.
		fs.writeFileSync(file, JSON.stringify({ ...base, failedCommands: [42] }));
		expect(loadDigest(dir, "sess-edge")).toBeNull();
	});
	test("appendRule truncates a single oversized rule to the char budget", () => {
		const dir = tmpDataDir();
		// maxChars 50 < MAX_RULE_CHARS 500: the single rule must be truncated
		// so the stored file fits the configured budget.
		const result = appendRule(dir, "z".repeat(200), 50, 50);
		// The truncated rule IS recorded — the verify must match the written
		// form, not the original key (was reporting "conflict" before).
		expect(result.added).toBe(true);
		expect(result.reason).toBe("added");
		const rules = loadRules(dir);
		expect(rules[0]!.length).toBeLessThanOrEqual(50);
		expect(rules.join("\n").length + 1).toBeLessThanOrEqual(50);
	});
	test("isValidDigest rejects tool-call args longer than 200 chars", () => {
		const dir = tmpDataDir();
		const file = digestFile(dir, "sess-args");
		fs.mkdirSync(path.dirname(file), { recursive: true });
		const base = digest();
		fs.writeFileSync(file, JSON.stringify({ ...base, toolCalls: [{ tool: "bash", args: "x".repeat(201) }] }));
		expect(loadDigest(dir, "sess-args")).toBeNull();
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

	test("cleanupStaleTmp also scans the skills dir", () => {
		const dir = tmpDataDir();
		// Skill tmps live one level deep: skills/<name>/SKILL.md.*.tmp.
		const skillDir = path.join(dir, "skills", "debug-flaky-tests");
		fs.mkdirSync(skillDir, { recursive: true });
		const stale = path.join(skillDir, "SKILL.md.123.456.0.tmp");
		fs.writeFileSync(stale, "x");
		const old = Date.now() / 1000 - 7200;
		fs.utimesSync(stale, old, old);
		cleanupStaleTmp(dir);
		expect(fs.existsSync(stale)).toBe(false);
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

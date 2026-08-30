/**
 * Tests for reflection prompt construction (src/reflect.ts).
 */

import { describe, expect, test } from "bun:test";

import { buildDigest } from "../src/digest.ts";
import { buildReflectionMessage, buildRulesAppendix, formatDigest, OUROBOROS_CUSTOM_TYPE } from "../src/reflect.ts";

const RULES_PATH = "/home/user/.pi/agent/ouroboros/rules.md";

const digest = () =>
	buildDigest(
		[
			{ type: "session", id: "sess-1", cwd: "/proj", timestamp: "2026-08-30T10:00:00.000Z" },
			{ type: "message", message: { role: "user", content: "fix the bug" } },
			{ type: "message", message: { role: "assistant", content: [], stopReason: "length", model: "vitruvix-code", usage: { input: 10, output: 5, cost: { total: 0.0001 } } } },
		],
		"sess-1",
		"/proj",
		"2026-08-30T12:00:00.000Z",
	);

describe("formatDigest", () => {
	test("renders the key facts", () => {
		const text = formatDigest(digest());
		expect(text).toContain("session: sess-1");
		expect(text).toContain("cwd: /proj");
		expect(text).toContain("models: vitruvix-code");
		expect(text).toContain("stop reasons: length: 1");
		expect(text).toContain("user prompts:");
		expect(text).toContain("- fix the bug");
		expect(text).toContain("$0.0001");
	});
});

describe("buildReflectionMessage", () => {
	test("contains digest, the real rules path, and writing instructions", () => {
		const msg = buildReflectionMessage(digest(), RULES_PATH);
		expect(msg).toContain("[Ouroboros]");
		expect(msg).toContain(RULES_PATH);
		expect(msg).toContain("ouroboros_learn");
		expect(msg).toContain("~/.pi/agent/skills/<name>/SKILL.md");
		expect(msg).toContain("<digest>");
		expect(msg).toContain("</digest>");
		expect(msg).toContain("fix the bug");
	});

	test("warns against rules that conflict with user instructions", () => {
		const msg = buildReflectionMessage(digest(), RULES_PATH);
		expect(msg).toContain("Do not record rules that conflict");
	});
});

describe("buildRulesAppendix", () => {
	test("formats rules as a system-prompt section", () => {
		const appendix = buildRulesAppendix(["rule one", "rule two"]);
		expect(appendix).toContain("## Ouroboros lessons");
		expect(appendix).toContain("- rule one");
		expect(appendix).toContain("- rule two");
	});

	test("puts the newest rules first", () => {
		const appendix = buildRulesAppendix(["old rule", "new rule"]);
		expect(appendix.indexOf("- new rule")).toBeLessThan(appendix.indexOf("- old rule"));
	});

	test("caps by character budget, keeping whole rules", () => {
		const rules = ["x".repeat(150), "y".repeat(150), "z".repeat(150)];
		const appendix = buildRulesAppendix(rules, 200);
		expect(appendix).toContain("z".repeat(150)); // newest kept
		expect(appendix).not.toContain("y".repeat(150)); // middle dropped at cap
		expect(appendix).not.toContain("x".repeat(150)); // oldest dropped at cap
	});

	test("skips oversized rules instead of dropping the whole appendix", () => {
		const rules = ["a".repeat(5000), "small rule"];
		const appendix = buildRulesAppendix(rules, 200);
		expect(appendix).toContain("- small rule");
		expect(appendix).not.toContain("a".repeat(5000));
	});

	test("returns empty for no rules", () => {
		expect(buildRulesAppendix([])).toBe("");
	});
});

describe("OUROBOROS_CUSTOM_TYPE", () => {
	test("is a stable identifier", () => {
		expect(OUROBOROS_CUSTOM_TYPE).toBe("ouroboros");
	});
});

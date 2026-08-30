/**
 * Tests for the session digest extractor (src/digest.ts).
 */

import { describe, expect, test } from "bun:test";

import { buildDigest, extractText, isNotable } from "../src/digest.ts";

const SID = "sess-123";
const CWD = "/home/user/proj";
const END = "2026-08-30T12:00:00.000Z";

function entry(partial: Record<string, unknown>): Record<string, unknown> {
	return { type: "message", id: "a1b2c3d4", parentId: null, timestamp: END, ...partial };
}

function userMessage(text: string): Record<string, unknown> {
	return entry({ message: { role: "user", content: text } });
}

function assistantMessage(over: Record<string, unknown> = {}): Record<string, unknown> {
	return entry({
		message: {
			role: "assistant",
			content: [{ type: "text", text: "doing work" }],
			stopReason: "stop",
			model: "vitruvix-code",
			usage: { input: 100, output: 50, cost: { total: 0.001 } },
			...over,
		},
	});
}

function toolError(toolName: string, text: string): Record<string, unknown> {
	return entry({
		message: { role: "toolResult", content: [{ type: "text", text }] },
		isError: true,
		toolName,
	});
}

function bashFailure(command: string, exitCode = 1): Record<string, unknown> {
	return entry({ message: { role: "bashExecution" }, command, exitCode });
}

describe("buildDigest", () => {
	test("extracts user prompts, errors, failed commands, stop reasons, usage", () => {
		const entries = [
			{ type: "session", id: SID, cwd: CWD, timestamp: "2026-08-30T10:00:00.000Z" },
			userMessage("fix the auth bug"),
			assistantMessage(),
			toolError("edit", "file not found"),
			bashFailure("npm test", 1),
			assistantMessage({ stopReason: "length", model: "vitruvix-high" }),
			userMessage("now the tests"),
		];
		const d = buildDigest(entries, SID, CWD, END);

		expect(d.sessionId).toBe(SID);
		expect(d.cwd).toBe(CWD);
		expect(d.startedAt).toBe("2026-08-30T10:00:00.000Z");
		expect(d.endedAt).toBe(END);
		expect(d.userPrompts).toEqual(["fix the auth bug", "now the tests"]);
		expect(d.errors).toEqual([{ tool: "edit", summary: "file not found" }]);
		expect(d.failedCommands).toEqual(["npm test"]);
		expect(d.stopReasons).toEqual({ stop: 1, length: 1 });
		expect(d.models).toEqual(["vitruvix-code", "vitruvix-high"]);
		expect(d.usage).toEqual({ input: 200, output: 100, cost: 0.002 });
		expect(d.messageCount).toBe(6);
	});

	test("dedupes identical errors and failed commands", () => {
		const entries = [toolError("edit", "boom"), toolError("edit", "boom"), bashFailure("npm test"), bashFailure("npm test")];
		const d = buildDigest(entries, SID, CWD, END);
		expect(d.errors).toHaveLength(1);
		expect(d.failedCommands).toHaveLength(1);
	});

	test("counts compactions and keeps only the newest prompts", () => {
		const entries = [
			{ type: "compaction", summary: "early part", tokensBefore: 5000 },
			...Array.from({ length: 20 }, (_, i) => userMessage(`prompt ${i}`)),
		];
		const d = buildDigest(entries, SID, CWD, END);
		expect(d.compactions).toBe(1);
		expect(d.userPrompts).toHaveLength(12);
		expect(d.userPrompts[0]).toBe("prompt 8");
		expect(d.userPrompts[11]).toBe("prompt 19");
	});

	test("truncates long prompts and commands", () => {
		const long = "x".repeat(500);
		const d = buildDigest([userMessage(long), bashFailure(`echo ${long}`, 2)], SID, CWD, END);
		expect(d.userPrompts[0]).toHaveLength(241); // 240 + ellipsis
		expect(d.userPrompts[0]!.endsWith("…")).toBe(true);
		expect(d.failedCommands[0]).toHaveLength(161);
	});

	test("ignores successful bash and non-error tool results", () => {
		const entries = [
			entry({ message: { role: "bashExecution" }, command: "npm test", exitCode: 0 }),
			entry({ message: { role: "toolResult", content: [{ type: "text", text: "ok" }] }, isError: false, toolName: "edit" }),
		];
		const d = buildDigest(entries, SID, CWD, END);
		expect(d.failedCommands).toHaveLength(0);
		expect(d.errors).toHaveLength(0);
	});

	test("is defensive against malformed entries", () => {
		const entries = [null, 42, "junk", { type: "message" }, { type: "message", message: { role: "user" } }, { type: "weird" }];
		const d = buildDigest(entries, SID, CWD, END);
		expect(d.userPrompts).toHaveLength(0);
		expect(d.errors).toHaveLength(0);
		expect(d.messageCount).toBe(1);
	});

	test("extracts text from string and block content", () => {
		expect(extractText("plain")).toBe("plain");
		expect(extractText([{ type: "text", text: "a" }, { type: "text", text: "b" }])).toBe("a\nb");
		expect(extractText([{ type: "toolCall", name: "bash", arguments: {} }])).toBe("[tool:bash]");
		expect(extractText([{ type: "thinking", thinking: "hidden" }])).toBe("");
		expect(extractText(42)).toBe("");
	});
});

describe("isNotable", () => {
	const base = () => buildDigest([], SID, CWD, END);

	test("true on errors, failed commands, length stops, compactions", () => {
		expect(isNotable({ ...base(), errors: [{ tool: "edit", summary: "x" }] }, 5)).toBe(true);
		expect(isNotable({ ...base(), failedCommands: ["npm test"] }, 5)).toBe(true);
		expect(isNotable({ ...base(), stopReasons: { length: 1 } }, 5)).toBe(true);
		expect(isNotable({ ...base(), compactions: 1 }, 5)).toBe(true);
	});

	test("true when enough prompts, false for a quiet clean session", () => {
		expect(isNotable({ ...base(), userPrompts: ["a", "b", "c", "d", "e"] }, 5)).toBe(true);
		expect(isNotable({ ...base(), userPrompts: ["a", "b"] }, 5)).toBe(false);
		expect(isNotable(base(), 5)).toBe(false);
	});
});

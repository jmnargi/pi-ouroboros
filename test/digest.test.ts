/**
 * Tests for the session digest extractor (src/digest.ts).
 */

import { describe, expect, test } from "bun:test";

import { buildDigest, extractText, isNotable } from "../src/digest.ts";
import { isValidDigest } from "../src/persistence.ts";

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

// Real session shape: isError/toolName live on entry.message (session-format.md).
function toolError(toolName: string, text: string): Record<string, unknown> {
	return entry({
		message: { role: "toolResult", content: [{ type: "text", text }], isError: true, toolName },
	});
}
// Real session shape: bash tool calls are toolResult entries with the exit
// code in the text; the command lives on the matching assistant toolCall.
function bashToolCall(id: string, command: string): Record<string, unknown> {
	return entry({
		message: {
			role: "assistant",
			content: [{ type: "toolCall", id, name: "bash", arguments: { command } }],
			stopReason: "toolUse",
		},
	});
}
function bashToolResult(id: string, text: string, isError = false): Record<string, unknown> {
	return entry({
		message: { role: "toolResult", toolCallId: id, toolName: "bash", content: [{ type: "text", text }], isError },
	});
}

// Documented bashExecution role (command/output/exitCode on the message).
// Real messages always carry output (agent-session.js:2222-2226).
function bashFailure(command: string, exitCode = 1, output = ""): Record<string, unknown> {
	return entry({ message: { role: "bashExecution", command, output, exitCode } });
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
		expect(d.failedCommands).toEqual([{ command: "npm test", error: "(no output)" }]);
		expect(d.stopReasons).toEqual({ stop: 1, length: 1 });
		expect(d.models).toEqual(["vitruvix-code", "vitruvix-high"]);
		expect(d.usage).toEqual({ input: 200, output: 100, cost: 0.002 });
		expect(d.messageCount).toBe(6);
	});

	test("captures the assistant trace (tool calls and text)", () => {
		const entries = [
			userMessage("fix the bug"),
			assistantMessage(), // text: "doing work"
			bashToolCall("call-1", "npm test"),
			bashToolResult("call-1", "ok\n"),
			assistantMessage({ content: [{ type: "text", text: "done" }] }),
		];
		const d = buildDigest(entries, SID, CWD, END);
		expect(d.assistantText).toEqual(["doing work", "done"]);
		expect(d.toolCalls).toEqual([{ tool: "bash", args: '{"command":"npm test"}' }]);
	});
	test("caps the trace during the loop: newest 20 tool calls, 12 texts, args at 80 chars", () => {
		const entries: Record<string, unknown>[] = [];
		for (let i = 0; i < 25; i++) {
			entries.push(bashToolCall(`call-${i}`, `command ${i}`));
			entries.push(bashToolResult(`call-${i}`, "ok\n"));
			entries.push(assistantMessage({ content: [{ type: "text", text: `text ${i}` }] }));
		}
		const d = buildDigest(entries, SID, CWD, END);
		expect(d.toolCalls).toHaveLength(20);
		expect(d.toolCalls[0]!.tool).toBe("bash");
		expect(d.toolCalls[0]!.args).toContain("command 5");
		expect(d.toolCalls[19]!.args).toContain("command 24");
		expect(d.assistantText).toHaveLength(12);
		expect(d.assistantText[0]).toBe("text 13");
		expect(d.assistantText[11]).toBe("text 24");
	});
	test("truncates tool-call args to 80 chars", () => {
		const longArgs = { command: "x".repeat(200) };
		const d = buildDigest(
			[entry({ message: { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "bash", arguments: longArgs }], stopReason: "toolUse" } })],
			SID,
			CWD,
			END,
		);
		expect(d.toolCalls).toHaveLength(1);
		// truncate keeps 80 chars plus an ellipsis.
		expect(d.toolCalls[0]!.args.length).toBeLessThanOrEqual(81);
		expect(d.toolCalls[0]!.args.endsWith("…")).toBe(true);
	});
	test("captures failed bash tool calls from the real toolResult shape", () => {
		const entries = [
			bashToolCall("call-1", "ls /nonexistent-dir-xyz"),
			bashToolResult("call-1", "ls: cannot access '/nonexistent-dir-xyz': No such file or directory\n\n\nCommand exited with code 2", true),
			bashToolCall("call-2", "npm test"),
			bashToolResult("call-2", "1 failing\n\n\nCommand exited with code 1", true),
			bashToolCall("call-3", "echo ok"),
			bashToolResult("call-3", "ok\n"),
		];
		const d = buildDigest(entries, SID, CWD, END);
		expect(d.failedCommands).toEqual([{ command: "ls /nonexistent-dir-xyz", error: "ls: cannot access '/nonexistent-dir-xyz': No such file or directory Command exited with code 2" }, { command: "npm test", error: "1 failing Command exited with code 1" }]);
	});
	test("bashExecution records the real output tail, not the no-output fallback", () => {
		const d = buildDigest([bashFailure("npm test", 1, "1 failing\n\n\nCommand exited with code 1")], SID, CWD, END);
		expect(d.failedCommands).toHaveLength(1);
		expect(d.failedCommands[0]!.error).toContain("Command exited with code 1");
		expect(d.failedCommands[0]!.error).not.toBe("(no output)");
	});
	test("user messages with the real array-content shape land in userPrompts", () => {
		// Real session files carry user content as a block array.
		const d = buildDigest([entry({ message: { role: "user", content: [{ type: "text", text: "fix the bug" }] } })], SID, CWD, END);
		expect(d.userPrompts).toEqual(["fix the bug"]);
		expect(d.userPromptCount).toBe(1);
	});

	test("ignores successful bash results even when they print exit codes", () => {
		const entries = [
			bashToolCall("call-1", "false; echo \"exit code: $?\""),
			bashToolResult("call-1", "exit code: 1\n"), // command exited 0 (echo succeeded)
			bashToolCall("call-2", "echo \"exit code: 5\""),
			bashToolResult("call-2", "exit code: 5\n"),
			// The discriminating case: a SUCCESSFUL command that merely
			// prints the failure string — isError false must not record it.
			bashToolCall("call-3", "echo 'Command exited with code 5'"),
			bashToolResult("call-3", "Command exited with code 5\n"),
		];
		const d = buildDigest(entries, SID, CWD, END);
		expect(d.failedCommands).toEqual([]);
	});

	test("records unknown command for orphan failed bash results", () => {
		const d = buildDigest([bashToolResult("orphan", "Command exited with code 1", true)], SID, CWD, END);
		expect(d.failedCommands).toEqual([{ command: "(unknown command)", error: "Command exited with code 1" }]);
	});
	test("uses the caller-provided startedAt when no header entry exists", () => {
		const d = buildDigest([userMessage("hi")], SID, CWD, END, "2026-08-30T09:00:00.000Z");
		expect(d.startedAt).toBe("2026-08-30T09:00:00.000Z");
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
		expect(d.failedCommands[0]!.command).toHaveLength(161);
	});

	test("strips control characters from digest text", () => {
		const d = buildDigest([userMessage("hello\u0000world\u001b[31mred")], SID, CWD, END);
		expect(d.userPrompts[0]).toBe("helloworld[31mred"); // ESC stripped, text remains

	});

	test("truncation keeps content after stripped characters (Data F2)", () => {
		// Cleaning removes chars, so the surviving content can start far into
		// the input — the bound must grow until enough survives.
		const nul = buildDigest([userMessage("a" + "\u0000".repeat(20) + "b" + "x".repeat(100))], SID, CWD, END);
		expect(nul.userPrompts[0]).toBe("ab" + "x".repeat(100));
		const spaces = buildDigest([userMessage("a" + " ".repeat(1000) + "b" + "y".repeat(100))], SID, CWD, END);
		expect(spaces.userPrompts[0]).toBe("a by" + "y".repeat(99));
	});

	test("strips C1 control characters and line separators (Data F9)", () => {
		const d = buildDigest([userMessage("a\u009b31mb\u2028c\u2029d")], SID, CWD, END);
		expect(d.userPrompts[0]).toBe("a31mbcd");
	});

	test("truncation does not add an ellipsis to an exact-fit astral string", () => {
		// 20 emoji = 20 code points = 40 UTF-16 units; max=20 code points.
		const d = buildDigest([userMessage("😀".repeat(20))], SID, CWD, END);
		expect(d.userPrompts[0]).toBe("😀".repeat(20));
		expect(d.userPrompts[0]!.endsWith("…")).toBe(false);
	});

	test("control-character-only prompts produce no digest entries", () => {
		const d = buildDigest([userMessage("\u0000\u0000\u0000")], SID, CWD, END);
		expect(d.userPrompts).toEqual([]);
	});
	test("format-control characters (zero-width, bidi overrides) are stripped", () => {
		// U+200B zero-width space, U+202E bidi override, U+2060 word joiner.
		const d = buildDigest([userMessage("a\u200bb\u202ec\u2060d")], SID, CWD, END);
		expect(d.userPrompts[0]).toBe("abcd");
		expect(isValidDigest(d)).toBe(true);
	});

	test("truncation never splits surrogate pairs and the digest round-trips (SEC-ROUND9-01)", () => {
		const emoji = "😀".repeat(300); // 600 UTF-16 units, 300 code points
		const d = buildDigest([userMessage(emoji)], SID, CWD, END);
		expect(Array.from(d.userPrompts[0]!).length).toBe(241); // 240 code points + ellipsis
		expect(d.userPrompts[0]!.endsWith("…")).toBe(true);
		// No lone surrogates: every char must round-trip through JSON.
		expect(JSON.parse(JSON.stringify(d.userPrompts[0]))).toBe(d.userPrompts[0]);
		// The validator measures CODE POINTS like the writer — a 481-unit
		// prompt must not fail validation (which would delete the digest).
		expect(isValidDigest(d)).toBe(true);
	});

	test("records version, dedupes models, and falls back usage fields", () => {
		const entries = [
			assistantMessage({ model: "vitruvix-code" }),
			assistantMessage({ model: "vitruvix-code", usage: { input: 5 } }),
			entry({ message: { role: "toolResult", content: [{ type: "text", text: "boom" }], isError: true } }),
		];
		const d = buildDigest(entries, SID, CWD, END);
		expect(d.version).toBe(1);
		expect(d.models).toEqual(["vitruvix-code"]);
		expect(d.usage).toEqual({ input: 105, output: 50, cost: 0.001 }); // missing fields → 0
		expect(d.errors).toEqual([{ tool: "tool", summary: "boom" }]); // no toolName → "tool"
	});
	test("caps stop reasons at 20 and sanitizes keys", () => {
		const entries = Array.from({ length: 30 }, (_, i) => assistantMessage({ stopReason: `reason-${i}` }));
		const d = buildDigest(entries, SID, CWD, END);
		expect(Object.keys(d.stopReasons)).toHaveLength(20);
		// A crafted stopReason with control chars is sanitized at capture.
		const dirty = buildDigest([assistantMessage({ stopReason: "ok\u0007reason" })], SID, CWD, END);
		expect(dirty.stopReasons).toEqual({ okreason: 1 });
		// Tab/LF/CR are in the validator's rejected class too — a key that
		// survives the writer must round-trip through saveDigest/loadDigest.
		const tabbed = buildDigest([assistantMessage({ stopReason: "stop\treason" })], SID, CWD, END);
		expect(tabbed.stopReasons).toEqual({ stopreason: 1 });
		expect(isValidDigest(tabbed)).toBe(true);
	});
	test("stop reasons named after Object.prototype properties stay numeric (SEC-ROUND8-01)", () => {
		// 'constructor'/'toString' must not resolve to the inherited function
		// (which would string-concatenate and corrupt the digest).
		const d = buildDigest(
			[assistantMessage({ stopReason: "constructor" }), assistantMessage({ stopReason: "toString" }), assistantMessage({ stopReason: "constructor" })],
			SID,
			CWD,
			END,
		);
		expect(d.stopReasons).toEqual({ constructor: 2, toString: 1 });
		// The digest must pass validation (numeric counts).
		expect(isValidDigest(d)).toBe(true);
	});
	test("'__proto__' stop reason is recorded as an own property (FixAudit6)", async () => {
		const d = buildDigest([assistantMessage({ stopReason: "__proto__" })], SID, CWD, END);
		expect(Object.hasOwn(d.stopReasons, "__proto__")).toBe(true);
		expect(d.stopReasons["__proto__"]).toBe(1);
		expect(isValidDigest(d)).toBe(true);
		// The key must survive the save -> load round-trip (migrateDigest
		// runs on every load and must not swallow it via the setter).
		const { mkdtempSync, rmSync } = await import("node:fs");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		const { saveDigest, loadDigest } = await import("../src/persistence.ts");
		const dir = mkdtempSync(join(tmpdir(), "ouro-proto-"));
		try {
			saveDigest(dir, d);
			const loaded = loadDigest(dir, SID);
			expect(loaded).not.toBeNull();
			expect(Object.hasOwn(loaded!.stopReasons, "__proto__")).toBe(true);
			expect(loaded!.stopReasons["__proto__"]).toBe(1);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
	test("cleanName never splits a surrogate pair in tool names (FixAudit6)", () => {
		// A 100-unit tool name ending in an emoji: the code-point cut must
		// not leave a lone surrogate.
		const name = "x".repeat(99) + "😀";
		const d = buildDigest(
			[entry({ message: { role: "assistant", content: [{ type: "toolCall", id: "c1", name, arguments: { command: "x" } }], stopReason: "toolUse" } })],
			SID,
			CWD,
			END,
		);
		// 100 code points kept (the emoji counts as one), never a lone surrogate.
		expect(Array.from(d.toolCalls[0]!.tool)).toHaveLength(100);
		// No lone surrogates: every code point is outside the surrogate range.
		for (const ch of d.toolCalls[0]!.tool) {
			const cp = ch.codePointAt(0)!;
			expect(cp < 0xd800 || cp > 0xdfff).toBe(true);
		}
	});
	test("a multi-MB model string is bounded at capture (SEC-18-01)", () => {
		// cleanName must not materialize a multi-MB array on a crafted
		// session-file model string. The output contract: 200 code points.
		const d = buildDigest(
			[entry({ message: { role: "assistant", content: [], stopReason: "stop", model: "m".repeat(5_000_000) } })],
			SID,
			CWD,
			END,
		);
		expect(d.models[0]).toBe("m".repeat(200));
		expect(isValidDigest(d)).toBe(true);
	});
	test("a nested-array args object is bounded at capture (SEC-18-03)", () => {
		// JSON.stringify renders undefined array elements as null, so a
		// nested array must be sliced in the replacer, not just at the top.
		const d = buildDigest(
			[entry({ message: { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "bash", arguments: { command: Array.from({ length: 1_000_000 }, (_, i) => i) } }], stopReason: "toolUse" } })],
			SID,
			CWD,
			END,
		);
		expect(d.toolCalls[0]!.args.length).toBeLessThan(200);
		expect(isValidDigest(d)).toBe(true);
	});
	test("tool names and models with control chars are sanitized at capture (SEC-ROUND8-02)", () => {
		const d = buildDigest(
			[
				entry({
					message: {
						role: "assistant",
						content: [{ type: "toolCall", id: "c1", name: "bash\u2028evil", arguments: { command: "x" } }],
						stopReason: "toolUse",
						model: "vitruvix\u001bcode",
					},
				}),
			],
			SID,
			CWD,
			END,
		);
		expect(d.toolCalls[0]!.tool).not.toContain("\u2028");
		expect(d.models[0]).not.toContain("\u001b");
	});
	test("error tool names with control chars are sanitized and bounded", () => {
		const d = buildDigest(
			[entry({ message: { role: "toolResult", content: [{ type: "text", text: "boom" }], isError: true, toolName: "edit\u2028evil" } })],
			SID,
			CWD,
			END,
		);
		expect(d.errors[0]!.tool).not.toContain("\u2028");
	});

	test("caps errors and failed commands at 20 each", () => {
		const entries = [
			...Array.from({ length: 30 }, (_, i) => toolError("edit", `error ${i}`)),
			...Array.from({ length: 30 }, (_, i) => bashFailure(`cmd ${i}`, 1)),
		];
		const d = buildDigest(entries, SID, CWD, END);
		expect(d.errors).toHaveLength(20);
		expect(d.failedCommands).toHaveLength(20);
		expect(d.errors[19]!.summary).toBe("error 29"); // newest kept
	});

	test("ignores successful bash and non-error tool results", () => {
		const entries = [
			entry({ message: { role: "bashExecution", command: "npm test", exitCode: 0 } }),
			entry({ message: { role: "toolResult", content: [{ type: "text", text: "ok" }], isError: false, toolName: "edit" } }),
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
	test("extractText keeps both ends of an oversized block (RuntimeIntegration7)", () => {
		// truncateTail needs the tail (bash errors put the exit code at
		// the end); truncate needs the prefix. The block slice must keep
		// both.
		const out = extractText([{ type: "text", text: "x".repeat(5000) + "Command exited with code 2" }]);
		expect(out.startsWith("x".repeat(1000))).toBe(true);
		expect(out.endsWith("Command exited with code 2")).toBe(true);
		expect(out.length).toBeLessThan(2100);
	});
	test("a control char in the cwd parameter cannot break validation (TestQuality3)", () => {
		// No session-header entry: the production path (session_shutdown)
		// passes RAW parameter values — getEntries() excludes session
		// entries in the real runtime. The parameters must be sanitized at
		// assignment, or the digest fails validation on load and the
		// reflection is silently deleted.
		const d = buildDigest([userMessage("hi")], SID, "/proj\u200bdir", END);
		expect(d.cwd).toBe("/projdir");
		expect(isValidDigest(d)).toBe(true);
	});
	test("a huge control-char tail is bounded and keeps the last code points (FixAudit8)", () => {
		// Performance guard: the geometric loop must not materialize a
		// 10M-element array (the pre-fix Array.from implementation passes
		// the content assertions but is slow/OOM on this input), and the
		// last max code points of the cleaned text must survive.
		const big = "A".repeat(5_000_000) + "\u0000".repeat(5_000_000) + "tail";
		const d = buildDigest([bashFailure("npm test", 1, big)], SID, CWD, END);
		expect(d.failedCommands[0]!.error).toContain("tail");
		expect(d.failedCommands[0]!.error.length).toBeLessThan(400);
	});
	test("a huge whitespace tail collapses without unbounded work (FixAudit8)", () => {
		const big = "x".repeat(100) + " ".repeat(5_000_000) + "END";
		const d = buildDigest([bashFailure("npm test", 1, big)], SID, CWD, END);
		expect(d.failedCommands[0]!.error).toContain("END");
	});
	test("a stopReason key with an astral char at the boundary is cut by code points (FixAudit8)", () => {
		// 'x'*99 + emoji is 100 code points / 101 units: a UTF-16 slice
		// would split the pair. cleanName must keep the emoji intact.
		const d = buildDigest([assistantMessage({ stopReason: "x".repeat(99) + "😀" })], SID, CWD, END);
		expect(Object.hasOwn(d.stopReasons, "x".repeat(99) + "😀")).toBe(true);
		expect(isValidDigest(d)).toBe(true);
	});
	test("a lone surrogate in a tool name is stripped, not passed through (Security7)", () => {
		// A crafted session file can carry a lone surrogate (a legacy
		// UTF-16 slice artifact). cleanName strips it so the digest stays
		// valid and the reflection is not lost.
		const d = buildDigest([toolError("edit\uD800x", "boom")], SID, CWD, END);
		expect(d.errors[0]!.tool).toBe("editx");
		expect(isValidDigest(d)).toBe(true);
	});
	test("a lone surrogate in a user prompt round-trips through validation (TestQuality4)", () => {
		// truncate/truncateTail must strip lone surrogates too — the writer
		// contract is that buildDigest output always passes isValidDigest.
		const d = buildDigest([userMessage("fix \ud800 the bug")], SID, CWD, END);
		expect(d.userPrompts[0]).toBe("fix the bug");
		expect(isValidDigest(d)).toBe(true);
	});
	test("content beyond the initial bound survives stripped chars (TestQuality4)", () => {
		// The geometric loop must grow past 2*max+1 units when the cleaned
		// content still fits: a fixed-bound implementation would drop the
		// leading 'x'*100 (it sits beyond the initial slice).
		const big = "x".repeat(100) + "\u0000".repeat(1000) + "y".repeat(50) + "END";
		const d = buildDigest([bashFailure("npm test", 1, big)], SID, CWD, END);
		expect(d.failedCommands[0]!.error).toContain("x".repeat(100));
		expect(d.failedCommands[0]!.error).toContain("END");
	});
	test("a lone surrogate at the tail boundary is handled without a split pair (TestQuality4)", () => {
		// The output ends in a lone high surrogate after a long run: the
		// tail must keep the last code points with no split pair and no
		// lone surrogate in the result.
		const big = "x".repeat(100) + "\ud800" + "y".repeat(60);
		const d = buildDigest([bashFailure("npm test", 1, big)], SID, CWD, END);
		const error = d.failedCommands[0]!.error;
		expect(error).toContain("y".repeat(60));
		expect([...error].some((c) => c.length === 1 && c.charCodeAt(0) >= 0xd800 && c.charCodeAt(0) <= 0xdfff)).toBe(false);
		expect(isValidDigest(d)).toBe(true);
	});
});

describe("isNotable", () => {
	const base = () => buildDigest([], SID, CWD, END);

	test("true on errors, failed commands, abnormal stops, compactions", () => {
		expect(isNotable({ ...base(), errors: [{ tool: "edit", summary: "x" }] }, 5)).toBe(true);
		expect(isNotable({ ...base(), failedCommands: [{ command: "npm test", error: "x" }] }, 5)).toBe(true);
		expect(isNotable({ ...base(), stopReasons: { length: 1 } }, 5)).toBe(true);
		expect(isNotable({ ...base(), stopReasons: { error: 1 } }, 5)).toBe(true);
		expect(isNotable({ ...base(), compactions: 1 }, 5)).toBe(true);
	});

	test("benign stop reasons alone do not make a session notable", () => {
		expect(isNotable({ ...base(), stopReasons: { stop: 4, toolUse: 3 } }, 5)).toBe(false);
	});

	test("true when enough prompts, false for a quiet clean session", () => {
		// userPromptCount is the uncapped counter — userPrompts itself is
		// capped at 12 by buildDigest, so isNotable must not read it.
		expect(isNotable({ ...base(), userPromptCount: 20 }, 5)).toBe(true);
		expect(isNotable({ ...base(), userPromptCount: 2 }, 5)).toBe(false);
		expect(isNotable(base(), 5)).toBe(false);
	});

	test("a real 20-prompt session is notable (buildDigest → isNotable)", () => {
		const entries = Array.from({ length: 20 }, (_, i) => userMessage(`prompt ${i}`));
		const d = buildDigest(entries, SID, CWD, END);
		expect(d.userPrompts).toHaveLength(12); // capped
		expect(d.userPromptCount).toBe(20); // uncapped
		expect(isNotable(d, 5)).toBe(true);
	});
});

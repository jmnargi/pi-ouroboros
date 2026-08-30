/**
 * Tests for the extension entry point (src/index.ts): event wiring,
 * tool/command registration, and the digest → reflection pipeline.
 *
 * The default export is driven with a mock ExtensionAPI; handlers are
 * captured and invoked with fake contexts. dataDir is pointed at a temp
 * directory via PI_CODING_AGENT_DIR.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import plugin from "../src/index.ts";
import { buildDigest } from "../src/digest.ts";

import { appendRule, digestsDir, loadRules, markDigestInjected, saveDigest, saveLastDigest, skillsDir } from "../src/persistence.ts";
import { OUROBOROS_CUSTOM_TYPE } from "../src/reflect.ts";

type Handler = (...args: unknown[]) => unknown;

interface MockTool {
	name: string;
	execute(...args: unknown[]): Promise<{ content: Array<{ type: string; text: string }> }>;
}

interface MockCommand {
	handler(...args: unknown[]): unknown;
}

interface MockMessage {
	message: { customType?: string; content?: string };
	options: { deliverAs?: string };
}
interface MockAPI {
	handlers: Map<string, Handler[]>;
	tools: MockTool[];
	commands: Map<string, MockCommand>;
	messages: MockMessage[];
	renderers: Map<string, unknown>;
	/** When true, sendMessage throws (simulates a future runtime change). */
	throwOnSend: boolean;
	on(event: string, handler: Handler): void;
	registerTool(tool: MockTool): void;
	registerCommand(name: string, options: MockCommand): void;
	registerMessageRenderer(type: string, renderer: unknown): void;
	sendMessage(message: MockMessage["message"], options: MockMessage["options"]): void;
	/** Invoke every handler for an event, in registration order. */
	fire(event: string, ...args: unknown[]): unknown;
}

function makeAPI(): MockAPI {
	const api: MockAPI = {
		handlers: new Map(),
		tools: [],
		commands: new Map(),
		messages: [],
		renderers: new Map(),
		throwOnSend: false,
		on(event, handler) {
			const list = api.handlers.get(event) ?? [];
			list.push(handler);
			api.handlers.set(event, list);
		},
		registerTool(tool) {
			api.tools.push(tool);
		},
		registerCommand(name, options) {
			api.commands.set(name, options);
		},
		registerMessageRenderer(type, renderer) {
			api.renderers.set(type, renderer);
		},
		sendMessage(message, options) {
			if (api.throwOnSend) throw new Error("sendMessage failed");
			api.messages.push({ message, options });
		},
		fire(event, ...args) {
			let result: unknown;
			for (const handler of api.handlers.get(event) ?? []) {
				result = handler(...args);
			}
			return result;
		},
	};
	return api;
}


/** A session entry list that produces a NOTABLE digest (has an error). */
function notableEntries(id = "sess-1"): unknown[] {
	return [
		{ type: "session", id, cwd: "/proj", timestamp: "2026-08-30T10:00:00.000Z" },
		{ type: "message", message: { role: "user", content: "fix the bug" } },
		{
			type: "message",
			message: {
				role: "assistant",
				content: [{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "npm test" } }],
				stopReason: "toolUse",
				model: "vitruvix-code",
				usage: { input: 10, output: 5, cost: { total: 0.0001 } },
			},
		},
		{
			type: "message",
			message: {
				role: "toolResult",
				toolCallId: "call-1",
				toolName: "bash",
				isError: true,
				content: [{ type: "text", text: "1 failing\n\nCommand exited with code 1" }],
			},
		},
	];
}

interface FakeSessionManager {
	getSessionId?(): string;
	getCwd?(): string;
	getSessionFile?(): string | undefined;
	getHeader?(): { timestamp?: string } | undefined;
	getEntries?(): unknown[];
}

interface FakeCtx {
	sessionManager: FakeSessionManager;
	hasUI: boolean;
	ui: { setStatus(key: string, text?: string): void; notify(message: string, type?: string): void };
}

function fakeCtx(overrides: Partial<FakeCtx> = {}): FakeCtx {
	return {
		sessionManager: {
			getSessionId: () => "sess-1",
			getCwd: () => "/proj",
			getSessionFile: () => "/proj/.pi/session.json",
			getHeader: () => ({ timestamp: "2026-08-30T10:00:00.000Z" }),
			getEntries: () => notableEntries(),
		},
		hasUI: false,
		ui: { setStatus: () => {}, notify: () => {} },
		...overrides,
	};
}

let dataDir: string;
let api: MockAPI;

beforeEach(() => {
	dataDir = mkdtempSync(join(tmpdir(), "ouroboros-index-"));
	process.env.PI_CODING_AGENT_DIR = dataDir;
	delete process.env.PI_OUROBOROS_DISABLED;
	api = makeAPI();
	// The mock is structurally compatible with ExtensionAPI; the cast is
	// needed because the real `on` has per-event overloads.
	plugin(api as unknown as ExtensionAPI);
});

afterEach(() => {
	delete process.env.PI_CODING_AGENT_DIR;
	rmSync(dataDir, { recursive: true, force: true });
});

describe("registration", () => {
	test("registers the tool, command, and lifecycle handlers", () => {
		expect(api.tools.map((t) => t.name)).toContain("ouroboros_learn");
		expect(api.commands.has("ouroboros")).toBe(true);
		for (const event of ["session_shutdown", "session_start", "before_agent_start"]) {
			expect(api.handlers.has(event)).toBe(true);
		}
	});

	test("no-ops when PI_OUROBOROS_DISABLED=1", () => {
		process.env.PI_OUROBOROS_DISABLED = "1";
		const quiet = makeAPI();
		plugin(quiet as unknown as ExtensionAPI);
		expect(quiet.handlers.size).toBe(0);
		expect(quiet.tools.length).toBe(0);
	});
});

describe("session_shutdown", () => {
	test("digests a quit session", () => {
		const handler = api.fire.bind(api, "session_shutdown");
		handler({ reason: "quit" }, fakeCtx());
		const files = readdirSync(digestsDir(dataDir));
		expect(files).toHaveLength(1);
		expect(files[0]).toMatch(/^sess-1\.json$/);
	});

	test("skips reload and fork", () => {
		const handler = api.fire.bind(api, "session_shutdown");
		handler({ reason: "reload" }, fakeCtx());
		handler({ reason: "fork" }, fakeCtx());
		expect(existsSync(digestsDir(dataDir))).toBe(false);
	});

	test("skips ephemeral sessions (no session file)", () => {
		const handler = api.fire.bind(api, "session_shutdown");
		handler(
			{ reason: "quit" },
			fakeCtx({ sessionManager: { getSessionFile: () => undefined, getSessionId: () => "sess-1", getEntries: () => notableEntries() } }),
		);
		expect(existsSync(digestsDir(dataDir))).toBe(false);
	});
});

describe("session_start", () => {
	test("injects a reflection for a notable digest and marks it", () => {
		saveDigest(dataDir, buildDigest(notableEntries(), "sess-1", "/proj", "2026-08-30T12:00:00.000Z"));
		const handler = api.fire.bind(api, "session_start");
		handler({}, fakeCtx());
		expect(api.messages).toHaveLength(1);
		expect(api.messages[0]!.message.customType).toBe(OUROBOROS_CUSTOM_TYPE);
		expect(api.messages[0]!.options.deliverAs).toBe("nextTurn");
		// The digest is renamed to .injected.json so it cannot be re-injected.
		const files = readdirSync(digestsDir(dataDir));
		expect(files).toEqual(["sess-1.injected.json"]);
	});

	test("deletes non-notable digests without injecting", () => {
		const quiet = buildDigest(
			[
				{ type: "session", id: "sess-1", cwd: "/proj", timestamp: "2026-08-30T10:00:00.000Z" },
				{ type: "message", message: { role: "user", content: "hi" } },
				{ type: "message", message: { role: "assistant", content: [], stopReason: "stop", model: "m", usage: { input: 1, output: 1, cost: { total: 0 } } } },
			],
			"sess-1",
			"/proj",
			"2026-08-30T12:00:00.000Z",
		);
		saveDigest(dataDir, quiet);
		const handler = api.fire.bind(api, "session_start");
		handler({}, fakeCtx());
		expect(api.messages).toHaveLength(0);
		expect(readdirSync(digestsDir(dataDir))).toEqual([]);
	});

	test("re-injects leftover injected digests from an undelivered reflection", () => {
		saveDigest(dataDir, buildDigest(notableEntries(), "sess-1", "/proj", "2026-08-30T12:00:00.000Z"));
		markDigestInjected(dataDir, "sess-1");
		const handler = api.fire.bind(api, "session_start");
		handler({}, fakeCtx());
		// The undelivered reflection is unmarked and re-injected.
		expect(api.messages).toHaveLength(1);
		expect(api.messages[0]!.message.customType).toBe(OUROBOROS_CUSTOM_TYPE);
		expect(readdirSync(digestsDir(dataDir))).toEqual(["sess-1.injected.json"]);
	});

	test("reload does not unmark or re-inject (message survives in the session)", () => {
		saveDigest(dataDir, buildDigest(notableEntries(), "sess-1", "/proj", "2026-08-30T12:00:00.000Z"));
		markDigestInjected(dataDir, "sess-1");
		const handler = api.fire.bind(api, "session_start");
		handler({ reason: "reload" }, fakeCtx());
		// The marker stays; the queued message is still pending delivery.
		expect(api.messages).toHaveLength(0);
		expect(readdirSync(digestsDir(dataDir))).toEqual(["sess-1.injected.json"]);
	});
	test("recovered digests are injected ahead of newer pending digests", () => {
		// Digest A (older, notable) has an undelivered reflection marker.
		// Digest B (newer, notable) is pending. The recovered A must be
		// injected FIRST; B is then deleted by the newest-wins rule.
		saveDigest(dataDir, buildDigest(notableEntries("sess-a"), "sess-a", "/proj", "2026-08-30T10:00:00.000Z"));
		markDigestInjected(dataDir, "sess-a");
		saveDigest(dataDir, buildDigest(notableEntries("sess-b"), "sess-b", "/proj", "2026-08-30T11:00:00.000Z"));
		const handler = api.fire.bind(api, "session_start");
		handler({}, fakeCtx());
		expect(api.messages).toHaveLength(1);
		expect(api.messages[0]!.message.content).toContain("sess-a");
		expect(readdirSync(digestsDir(dataDir))).toEqual(["sess-a.injected.json"]);
	});
	test("digests marked injected at entry are never deleted as stale (Concurrency2)", () => {
		// Both sess-a (older) and sess-b (newer) are marked injected at
		// entry. The unmark loop recovers both; the newest (sess-b) is
		// injected. sess-a is in initialInjected, so the stale-delete must
		// SKIP it — it stays pending for the next session start. Reverting
		// the skip deletes sess-a, failing this test.
		saveDigest(dataDir, buildDigest(notableEntries("sess-a"), "sess-a", "/proj", "2026-08-30T10:00:00.000Z"));
		markDigestInjected(dataDir, "sess-a");
		saveDigest(dataDir, buildDigest(notableEntries("sess-b"), "sess-b", "/proj", "2026-08-30T11:00:00.000Z"));
		markDigestInjected(dataDir, "sess-b");
		const handler = api.fire.bind(api, "session_start");
		handler({}, fakeCtx());
		expect(api.messages).toHaveLength(1);
		expect(api.messages[0]!.message.content).toContain("sess-b");
		expect(readdirSync(digestsDir(dataDir)).sort()).toEqual(["sess-a.json", "sess-b.injected.json"]);
	});
	test("a corrupt digest after an injected one is deleted by filename without parsing", () => {
		saveDigest(dataDir, buildDigest(notableEntries("sess-a"), "sess-a", "/proj", "2026-08-30T10:00:00.000Z"));
		markDigestInjected(dataDir, "sess-a");
		// sess-b is corrupt (not JSON). The injected flag is checked BEFORE
		// loadDigest, so sess-b is deleted without a parse attempt.
		writeFileSync(join(digestsDir(dataDir), "sess-b.json"), "{not json");
		const handler = api.fire.bind(api, "session_start");
		handler({}, fakeCtx());
		expect(api.messages).toHaveLength(1);
		expect(readdirSync(digestsDir(dataDir))).toEqual(["sess-a.injected.json"]);
	});
	test("resume with the reflection already in history deletes the marker, no re-inject", () => {
		saveDigest(dataDir, buildDigest(notableEntries(), "sess-1", "/proj", "2026-08-30T12:00:00.000Z"));
		markDigestInjected(dataDir, "sess-1");
		// The resumed session's entries already contain the ouroboros message
		// for THIS digest (drained before a failed first turn). The real
		// reflection content carries the digest block with "session: sess-1".
		const entries = [{ type: "custom_message", customType: OUROBOROS_CUSTOM_TYPE, content: "[Ouroboros] ...\nsession: sess-1\ncwd: /proj" }];
		const handler = api.fire.bind(api, "session_start");
		handler({ reason: "startup" }, fakeCtx({ sessionManager: { getEntries: () => entries } }));
		expect(api.messages).toHaveLength(0);
		expect(readdirSync(digestsDir(dataDir))).toEqual([]);
	});
	test("resume with an ouroboros message for a DIFFERENT digest re-injects (no false positive)", () => {
		saveDigest(dataDir, buildDigest(notableEntries(), "sess-1", "/proj", "2026-08-30T12:00:00.000Z"));
		markDigestInjected(dataDir, "sess-1");
		// The session has an ouroboros message from a PRIOR successful
		// reflection (session: sess-other). The marker is for sess-1, whose
		// reflection was never drained — it must be re-injected.
		const entries = [{ type: "custom_message", customType: OUROBOROS_CUSTOM_TYPE, content: "[Ouroboros] ...\nsession: sess-other\ncwd: /proj" }];
		const handler = api.fire.bind(api, "session_start");
		handler({ reason: "startup" }, fakeCtx({ sessionManager: { getEntries: () => entries } }));
		expect(api.messages).toHaveLength(1);
		expect(api.messages[0]!.message.customType).toBe(OUROBOROS_CUSTOM_TYPE);
		expect(readdirSync(digestsDir(dataDir))).toEqual(["sess-1.injected.json"]);
	});
	test("resume without the reflection in history re-injects it", () => {
		saveDigest(dataDir, buildDigest(notableEntries(), "sess-1", "/proj", "2026-08-30T12:00:00.000Z"));
		markDigestInjected(dataDir, "sess-1");
		// The resumed session has no ouroboros message (crash before the
		// first turn drained) — the reflection was never delivered.
		const handler = api.fire.bind(api, "session_start");
		handler({ reason: "startup" }, fakeCtx({ sessionManager: { getEntries: () => [] } }));
		expect(api.messages).toHaveLength(1);
		expect(api.messages[0]!.message.customType).toBe(OUROBOROS_CUSTOM_TYPE);
		expect(readdirSync(digestsDir(dataDir))).toEqual(["sess-1.injected.json"]);
	});
});

describe("before_agent_start", () => {
	test("appends the rules appendix to the system prompt", () => {
		appendRule(dataDir, "always re-read before editing");
		const handler = api.fire.bind(api, "before_agent_start");
		const result = handler({ systemPrompt: "base prompt" }) as { systemPrompt: string };
		expect(result.systemPrompt).toContain("base prompt");
		expect(result.systemPrompt).toContain("## Ouroboros lessons");
		expect(result.systemPrompt).toContain("always re-read before editing");
	});

	test("returns undefined when there are no rules", () => {
		const handler = api.fire.bind(api, "before_agent_start");
		expect(handler({ systemPrompt: "base prompt" })).toBeUndefined();
	});

	test("agent_end deletes the injected marker after delivery", () => {
		saveDigest(dataDir, buildDigest(notableEntries(), "sess-1", "/proj", "2026-08-30T12:00:00.000Z"));
		api.fire("session_start", {}, fakeCtx());
		expect(readdirSync(digestsDir(dataDir))).toEqual(["sess-1.injected.json"]);
		api.fire("agent_end", {});
		expect(readdirSync(digestsDir(dataDir))).toEqual([]);
	});

	test("agent_end keeps the marker when the run failed (stopReason error)", () => {
		saveDigest(dataDir, buildDigest(notableEntries(), "sess-1", "/proj", "2026-08-30T12:00:00.000Z"));
		api.fire("session_start", {}, fakeCtx());
		expect(readdirSync(digestsDir(dataDir))).toEqual(["sess-1.injected.json"]);
		// A failed run emits agent_end with an error/aborted message — the
		// reflection was not delivered, so the marker must survive.
		api.fire("agent_end", { messages: [{ role: "assistant", stopReason: "error" }] });
		expect(readdirSync(digestsDir(dataDir))).toEqual(["sess-1.injected.json"]);
	});
	test("agent_end keeps the marker when the run was aborted (stopReason aborted)", () => {
		saveDigest(dataDir, buildDigest(notableEntries(), "sess-1", "/proj", "2026-08-30T12:00:00.000Z"));
		api.fire("session_start", {}, fakeCtx());
		expect(readdirSync(digestsDir(dataDir))).toEqual(["sess-1.injected.json"]);
		api.fire("agent_end", { messages: [{ role: "assistant", stopReason: "aborted" }] });
		expect(readdirSync(digestsDir(dataDir))).toEqual(["sess-1.injected.json"]);
	});
	test("agent_end deletes the marker when the last message is benign", () => {
		saveDigest(dataDir, buildDigest(notableEntries(), "sess-1", "/proj", "2026-08-30T12:00:00.000Z"));
		api.fire("session_start", {}, fakeCtx());
		api.fire("agent_end", { messages: [{ role: "assistant", stopReason: "stop" }] });
		expect(readdirSync(digestsDir(dataDir))).toEqual([]);
 	});
 });
describe("ouroboros_learn tool", () => {
	const tool = (): MockTool => api.tools.find((t) => t.name === "ouroboros_learn")!;

	test("kind=rule appends to the rules file and dedupes", async () => {
		const t = tool();
		const first = await t.execute("call-1", { kind: "rule", lesson: "always re-read before editing" }, undefined, undefined, fakeCtx());
		expect(first.content[0]!.text).toContain("rule recorded");
		const second = await t.execute("call-2", { kind: "rule", lesson: "Always re-read before editing!" }, undefined, undefined, fakeCtx());
		expect(second.content[0]!.text).toContain("duplicate rule skipped");
		expect(loadRules(dataDir)).toHaveLength(1);
	});

	test("kind=rule respects PI_OUROBOROS_RULES_CAP", async () => {
		process.env.PI_OUROBOROS_RULES_CAP = "2";
		const capped = makeAPI();
		plugin(capped as unknown as ExtensionAPI);
		const t = capped.tools.find((x) => x.name === "ouroboros_learn")!;
		await t.execute("call-1", { kind: "rule", lesson: "rule one" }, undefined, undefined, fakeCtx());
		await t.execute("call-2", { kind: "rule", lesson: "rule two" }, undefined, undefined, fakeCtx());
		const third = await t.execute("call-3", { kind: "rule", lesson: "rule three" }, undefined, undefined, fakeCtx());
		expect(third.content[0]!.text).toContain("rule recorded (2/2)");
		expect(loadRules(dataDir)).toEqual(["rule two", "rule three"]);
		delete process.env.PI_OUROBOROS_RULES_CAP;
	});

	test("kind=skill writes a SKILL.md and validates the name", async () => {
		const t = tool();
		const result = await t.execute(
			"call-1",
			{ kind: "skill", lesson: "debug flaky tests", skillName: "debug-flaky-tests", skillDescription: "Find flaky tests", skillBody: "# Debug flaky tests\n\nRun them 10 times." },
			undefined,
			undefined,
			fakeCtx(),
		);
		expect(result.content[0]!.text).toContain("skill written");
		expect(existsSync(join(skillsDir(dataDir), "debug-flaky-tests", "SKILL.md"))).toBe(true);
		await expect(
			t.execute("call-2", { kind: "skill", lesson: "x", skillName: "Bad Name!", skillDescription: "d", skillBody: "b" }, undefined, undefined, fakeCtx()),
		).rejects.toThrow("skillName");
	});
	test("kind=skill rejects missing and oversized fields", async () => {
		const t = tool();
		const base = { kind: "skill", lesson: "x", skillName: "ok-name", skillDescription: "d", skillBody: "b" };
		await expect(t.execute("c1", { ...base, skillDescription: "" }, undefined, undefined, fakeCtx())).rejects.toThrow("skillDescription is required");
		await expect(t.execute("c2", { ...base, skillBody: "" }, undefined, undefined, fakeCtx())).rejects.toThrow("skillBody is required");
		await expect(t.execute("c3", { ...base, skillDescription: "d".repeat(201) }, undefined, undefined, fakeCtx())).rejects.toThrow("200 characters or fewer");
		await expect(t.execute("c4", { ...base, skillBody: "b".repeat(20_001) }, undefined, undefined, fakeCtx())).rejects.toThrow("20,000 characters or fewer");
	});
	test("kind=rule with a whitespace-only lesson reports empty", async () => {
		const t = tool();
		const result = await t.execute("c1", { kind: "rule", lesson: "   \n\t " }, undefined, undefined, fakeCtx());
		expect(result.content[0]!.text).toContain("lesson is empty");
		expect(loadRules(dataDir)).toHaveLength(0);
	});
	test("sendMessage failure restores the digest to pending (defense-in-depth)", () => {
		saveDigest(dataDir, buildDigest(notableEntries(), "sess-1", "/proj", "2026-08-30T12:00:00.000Z"));
		api.throwOnSend = true;
		const handler = api.fire.bind(api, "session_start");
		handler({}, fakeCtx());
		// The digest is unmarked so the next session start re-injects it.
		expect(api.messages).toHaveLength(0);
		expect(readdirSync(digestsDir(dataDir))).toEqual(["sess-1.json"]);
	});
	test("session_shutdown writes the last-digest copy for /ouroboros digest", () => {
		const handler = api.fire.bind(api, "session_shutdown");
		handler({ reason: "quit" }, fakeCtx());
		expect(existsSync(join(dataDir, "ouroboros", "last-digest.json"))).toBe(true);
	});
});

describe("/ouroboros command", () => {
	const cmd = (): MockCommand => api.commands.get("ouroboros")!;

	test("reset clears the rules", () => {
		appendRule(dataDir, "some rule");
		expect(loadRules(dataDir)).toHaveLength(1);
		cmd().handler("reset", fakeCtx());
		expect(loadRules(dataDir)).toHaveLength(0);
	});

	test("reflect queues a mid-session message without a digest", () => {
		cmd().handler("reflect", fakeCtx());
		expect(api.messages).toHaveLength(1);
		expect(api.messages[0]!.message.customType).toBe(OUROBOROS_CUSTOM_TYPE);
		expect(api.messages[0]!.message.content).not.toContain("<digest>");
		// A second reflect while queued is deduped.
		cmd().handler("reflect", fakeCtx());
		expect(api.messages).toHaveLength(1);
	});

	test("digest subcommand reports the last recorded digest", () => {
		saveLastDigest(dataDir, buildDigest(notableEntries(), "sess-1", "/proj", "2026-08-30T12:00:00.000Z"));
		const notified: string[] = [];
		const ctx = fakeCtx({ hasUI: true, ui: { setStatus: () => {}, notify: (m: string) => notified.push(m) } });
		cmd().handler("digest", ctx);
		expect(notified.join(" ")).toContain("sess-1");
	});
	test("default status reports rules, skills, and pending digests", () => {
		appendRule(dataDir, "always re-read before editing");
		const notified: string[] = [];
		const ctx = fakeCtx({ hasUI: true, ui: { setStatus: () => {}, notify: (m: string) => notified.push(m) } });
		cmd().handler(undefined, ctx);
		const text = notified.join(" ");
		expect(text).toContain("1 rules");
		expect(text).toContain("rules file:");
		expect(text).toContain("last rules:");
		expect(text).toContain("always re-read before editing");
	});
	test("digest subcommand reports no digest when none was recorded", () => {
		const notified: string[] = [];
		const ctx = fakeCtx({ hasUI: true, ui: { setStatus: () => {}, notify: (m: string) => notified.push(m) } });
		cmd().handler("digest", ctx);
		expect(notified.join(" ")).toContain("no digest recorded yet");
	});
	test("digest subcommand reports a corrupt last-digest file", () => {
		mkdirSync(join(dataDir, "ouroboros"), { recursive: true });
		writeFileSync(join(dataDir, "ouroboros", "last-digest.json"), "{not json");
		const notified: string[] = [];
		const ctx = fakeCtx({ hasUI: true, ui: { setStatus: () => {}, notify: (m: string) => notified.push(m) } });
		cmd().handler("digest", ctx);
		expect(notified.join(" ")).toContain("digest unreadable");
	});
});

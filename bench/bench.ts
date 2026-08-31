/**
 * bench/bench.ts — measure the hot paths of pi-ouroboros.
 *
 * Run with: bun bench/bench.ts
 *
 * The numbers in the README come from this script. Re-run it after any
 * change to the hot paths (digest building, digest listing, rules loading).
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildDigest, isNotable } from "../src/digest.ts";
import { appendRule, listDigests, listSkills, loadDigest, loadRules, saveDigest, writeSkill } from "../src/persistence.ts";

function bench(name: string, iterations: number, fn: () => void): void {
	// Warm up (caches, JIT).
	fn();
	const start = performance.now();
	for (let i = 0; i < iterations; i++) fn();
	const ms = (performance.now() - start) / iterations;
	console.log(`${name}: ${ms.toFixed(3)} ms/op (${iterations} iterations)`);
}

const dir = mkdtempSync(join(tmpdir(), "ouroboros-bench-"));
try {
	// 1. listDigests with 10k digests.
	const digests = join(dir, "ouroboros", "digests");
	mkdirSync(digests, { recursive: true });

	for (let i = 0; i < 10_000; i++) {
		writeFileSync(join(digests, `sess-${i}.json`), "{}");
	}
	bench("listDigests (10k digests)", 20, () => listDigests(dir));

	// 2. buildDigest with a 300KB prompt and a tool-call trace.
	const bigPrompt = "x".repeat(300_000);
	const entries = [
		{ type: "session", id: "sess-1", cwd: "/proj", timestamp: "2026-08-30T10:00:00.000Z" },
		{ type: "message", message: { role: "user", content: bigPrompt } },
		{
			type: "message",
			message: {
				role: "assistant",
				content: [
					{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "npm test" } },
					{ type: "text", text: "running the tests" },
				],
				stopReason: "toolUse",
				model: "m",
				usage: { input: 1, output: 1, cost: { total: 0 } },
			},
		},
		{ type: "message", message: { role: "toolResult", toolCallId: "c1", toolName: "bash", isError: true, content: [{ type: "text", text: "1 failing" }] } },
	];
	bench("buildDigest (300KB prompt + trace)", 200, () => buildDigest(entries, "sess-1", "/proj", "2026-08-30T12:00:00.000Z"));

	// 2b. buildDigest with 10k tool calls — the trace caps must keep the
	// cost flat (a revert to unbounded collection shows up in the numbers).
	const manyCalls: Array<Record<string, unknown>> = [
		{ type: "session", id: "sess-1", cwd: "/proj", timestamp: "2026-08-30T10:00:00.000Z" },
	];
	for (let i = 0; i < 10_000; i++) {
		manyCalls.push({
			type: "message",
			message: {
				role: "assistant",
				content: [{ type: "toolCall", id: `c${i}`, name: "bash", arguments: { command: `command ${i}` } }],
				stopReason: "toolUse",
			},
		});
	}
	bench("buildDigest (10k tool calls, capped)", 20, () => buildDigest(manyCalls, "sess-1", "/proj", "2026-08-30T12:00:00.000Z"));

	// 3. loadRules with a full rules file (cached).
	for (let i = 0; i < 50; i++) appendRule(dir, `rule number ${i}: always do the thing`);
	bench("loadRules (50 rules, cached)", 10_000, () => loadRules(dir));

	// 4. appendRule at cap (char eviction runs).
	bench("appendRule at cap (char eviction)", 200, () => appendRule(dir, `new rule ${Date.now()}`));

	// 5. listSkills (no cache — a few syscalls).
	writeSkill(dir, "bench-skill", "bench", "body");
	bench("listSkills (1 skill)", 10_000, () => listSkills(dir));

	// 6. saveDigest (atomic write).
	const digest = buildDigest(entries, "sess-1", "/proj", "2026-08-30T12:00:00.000Z");
	bench("saveDigest (atomic write)", 200, () => saveDigest(dir, digest));

	// 7. Session start: list + load + validate + isNotable, with 0/1/50
	// pending digests (a fresh dir per case so the counts are exact).
	const sessionStart = (count: number): (() => void) => {
		const d2 = mkdtempSync(join(tmpdir(), "ouroboros-bench-ss-"));
		for (let i = 0; i < count; i++) {
			saveDigest(d2, { ...digest, sessionId: `sess-${i}` });
		}
		return () => {
			const all = listDigests(d2);
			for (const sid of all) {
				const d = loadDigest(d2, sid);
				if (d && isNotable(d, 5)) break;
			}
		};
	};
	bench("session_start (0 digests)", 200, sessionStart(0));
	bench("session_start (1 digest)", 200, sessionStart(1));
	bench("session_start (50 digests)", 200, sessionStart(50));
} finally {
	rmSync(dir, { recursive: true, force: true });
}

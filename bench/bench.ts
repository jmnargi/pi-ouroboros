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

import { buildDigest } from "../src/digest.ts";
import { appendRule, listDigests, listSkills, loadRules, saveDigest, writeSkill } from "../src/persistence.ts";

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

	// 2. buildDigest with a 300KB prompt.
	const bigPrompt = "x".repeat(300_000);
	const entries = [
		{ type: "session", id: "sess-1", cwd: "/proj", timestamp: "2026-08-30T10:00:00.000Z" },
		{ type: "message", message: { role: "user", content: bigPrompt } },
		{ type: "message", message: { role: "assistant", content: [], stopReason: "stop", model: "m", usage: { input: 1, output: 1, cost: { total: 0 } } } },
	];
	bench("buildDigest (300KB prompt)", 200, () => buildDigest(entries, "sess-1", "/proj", "2026-08-30T12:00:00.000Z"));

	// 3. loadRules with a full rules file (cached).
	for (let i = 0; i < 50; i++) appendRule(dir, `rule number ${i}: always do the thing`);
	bench("loadRules (50 rules, cached)", 10_000, () => loadRules(dir));

	// 4. listSkills (cached).
	writeSkill(dir, "bench-skill", "bench", "body");
	bench("listSkills (1 skill, cached)", 10_000, () => listSkills(dir));

	// 5. saveDigest (atomic write).
	const digest = buildDigest(entries, "sess-1", "/proj", "2026-08-30T12:00:00.000Z");
	bench("saveDigest (atomic write)", 200, () => saveDigest(dir, digest));
} finally {
	rmSync(dir, { recursive: true, force: true });
}

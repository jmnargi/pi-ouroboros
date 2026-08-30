/**
 * src/reflect.ts — prompt construction for ouroboros (pure, no pi imports).
 *
 * Two text surfaces:
 *  1. The reflection message injected at the start of a new session — a
 *     compact digest of the previous session plus instructions to extract
 *     lessons and write them as rules/skills.
 *  2. The rules appendix appended to the system prompt every turn — the
 *     self-learned rules, capped so they never crowd out the real prompt.
 */

import type { OuroborosDigest } from "./digest.ts";

export const OUROBOROS_CUSTOM_TYPE = "ouroboros";

/** Render a digest as a compact, model-readable block. */
export function formatDigest(digest: OuroborosDigest): string {
	const lines: string[] = [];
	lines.push(`session: ${digest.sessionId}`);
	lines.push(`cwd: ${digest.cwd}`);
	if (digest.startedAt) lines.push(`started: ${digest.startedAt}`);
	lines.push(`ended: ${digest.endedAt}`);
	lines.push(`messages: ${digest.messageCount}`);
	if (digest.models.length > 0) lines.push(`models: ${digest.models.join(", ")}`);
	lines.push(
		`usage: ${digest.usage.input.toLocaleString()} in / ${digest.usage.output.toLocaleString()} out / $${digest.usage.cost.toFixed(4)}`,
	);
	if (digest.compactions > 0) lines.push(`compactions: ${digest.compactions}`);
	const stops = Object.entries(digest.stopReasons)
		.map(([k, v]) => `${k}: ${v}`)
		.join(", ");
	if (stops) lines.push(`stop reasons: ${stops}`);

	if (digest.userPrompts.length > 0) {
		lines.push("", "user prompts:");
		for (const p of digest.userPrompts) lines.push(`- ${p}`);
	}
	if (digest.errors.length > 0) {
		lines.push("", "failed tool calls:");
		for (const e of digest.errors) lines.push(`- ${e.tool}: ${e.summary}`);
	}
	if (digest.failedCommands.length > 0) {
		lines.push("", "failed commands:");
		for (const c of digest.failedCommands) lines.push(`- ${c}`);
	}
	return lines.join("\n");
}

/**
 * The reflection message injected at the start of a new session.
 * `rulesPath` is the real rules file the plugin reads (the model must write
 * to that exact path, or use the ouroboros_learn tool instead).
 */
export function buildReflectionMessage(digest: OuroborosDigest, rulesPath: string): string {
	return [
		"[Ouroboros] You just started a new session. Before addressing the user's request, spend at most ~200 tokens reflecting on the digest of your previous session below.",
		"",
		"1. Identify 1-3 concrete, actionable lessons: mistakes you made, rules that would have prevented them, or reusable procedures worth codifying.",
		`2. For each rule, append ONE imperative line to ${rulesPath} (do not duplicate existing lines; be specific to this project/stack). You can also use the ouroboros_learn tool with kind=rule, which writes to the same file.`,
		"3. If a multi-step procedure is worth codifying, write it as a skill: ~/.pi/agent/skills/<name>/SKILL.md with name + description frontmatter.",
		"4. Do not record rules that conflict with the user's explicit instructions.",
		"5. If nothing is genuinely worth recording, do nothing and move on.",
		"",
		"<digest>",
		formatDigest(digest),
		"</digest>",
	].join("\n");
}

/**
 * System-prompt appendix carrying the self-learned rules (capped).
 * Newest rules come first — the freshest lessons win. Oversized rules are
 * skipped, never allowed to drop the whole appendix.
 */
export function buildRulesAppendix(rules: string[], maxChars: number = 3000): string {
	const budget = Math.max(200, maxChars);
	let body = "";
	for (const rule of [...rules].reverse()) {
		const candidate = body ? `${body}\n- ${rule}` : `- ${rule}`;
		if (candidate.length > budget) continue;
		body = candidate;
	}
	if (!body) return "";
	return `\n\n## Ouroboros lessons (self-learned rules)\n${body}`;
}

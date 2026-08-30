/**
 * pi-ouroboros — self-improving pi coding agent.
 *
 * The loop:
 *  1. Session end (quit / new): a compact digest of the session is written to
 *     `<agentDir>/ouroboros/digests/<sessionId>.json` — user prompts, failed
 *     tool calls, failed commands, stop reasons, compaction pressure, usage.
 *  2. Next session start: if a pending digest is notable, a reflection message
 *     is queued (deliverAs "nextTurn") so the agent extracts lessons from its
 *     own past as part of its first turn — no startup delay, no extra API
 *     calls. The digest is consumed after injection.
 *  3. Every turn: self-learned rules from `<agentDir>/ouroboros/rules.md` are
 *     appended to the system prompt, so a lesson recorded mid-session is
 *     active the very next turn.
 *  4. `ouroboros_learn` lets the agent record a lesson immediately: kind=rule
 *     appends to rules.md (deduped, capped); kind=skill writes a SKILL.md that
 *     pi auto-discovers on the next startup.
 *
 * The agent does the reflection itself (in its own loop, with its own tools);
 * ouroboros is pure plumbing: deterministic digesting, file IO, and prompt
 * injection. Nothing here calls the model directly.
 */

import { existsSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Text } from "@earendil-works/pi-tui";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { buildDigest, isNotable, type OuroborosDigest } from "./digest.ts";
import {
	appendRule,
	clearRules,
	DEFAULT_REFLECT_MIN_PROMPTS,
	DEFAULT_RULES_CAP,
	DEFAULT_RULES_MAX_CHARS,
	deleteInjectedDigest,
	listInjectedDigests,
	markDigestInjected,
	unmarkDigestInjected,
	deleteDigest,
	listDigests,
	loadDigest,
	listSkills,
	loadRules,
	rulesFile,
	skillsDir,
	saveDigest,
	writeSkill,
	isValidSkillName,
	cleanupStaleTmp,
	loadLastDigest,
	lastDigestFile,
	saveLastDigest,
} from "./persistence.ts";
import { buildReflectionMessage, buildRulesAppendix, formatDigest, OUROBOROS_CUSTOM_TYPE } from "./reflect.ts";







interface UiHost {
	mode?: string;
	hasUI: boolean;
	ui: {
		setStatus(key: string, text: string | undefined): void;
		notify(message: string, type?: "info" | "warning" | "error"): void;
	};
}

function envInt(name: string, fallback: number): number {
	const raw = process.env[name];
	if (!raw || !/^\d+$/.test(raw)) return fallback;
	const n = Number.parseInt(raw, 10);
	return n > 0 ? n : fallback;
}

export default function (pi: ExtensionAPI): void {
	if (process.env.PI_OUROBOROS_DISABLED === "1") return;


	const dataDir = process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent");
	const rulesMaxChars = envInt("PI_OUROBOROS_RULES_MAX_CHARS", DEFAULT_RULES_MAX_CHARS);
	const rulesCap = envInt("PI_OUROBOROS_RULES_CAP", DEFAULT_RULES_CAP);
	const minPrompts = envInt("PI_OUROBOROS_REFLECT_MIN_PROMPTS", DEFAULT_REFLECT_MIN_PROMPTS);
	let uiHost: UiHost | undefined = undefined;
	/** True while a /ouroboros reflect message is queued (dedupe). */
	let reflectQueued = false;
	/** True while injected digests await cleanup — avoids a readdir every turn. */
	let hasInjectedDigests = false;
	const updateStatus = (): void => {
		const host = uiHost;
		if (!host?.hasUI) return;
		try {
			const rules = loadRules(dataDir);
			const skills = listSkills(dataDir);
			const injected = listInjectedDigests(dataDir);
			if (injected.length > 0) hasInjectedDigests = true;
			if (rules.length === 0 && skills.length === 0 && injected.length === 0) {
				host.ui.setStatus("ouroboros", undefined);
				return;
			}
			const parts = [`⟳ ${rules.length} rule${rules.length === 1 ? "" : "s"}`];
			if (skills.length > 0) parts.push(`${skills.length} skill${skills.length === 1 ? "" : "s"}`);
			if (injected.length > 0) parts.push("reflection queued");
			host.ui.setStatus("ouroboros", parts.join(" · "));
		} catch {
			// best-effort (print/rpc/teardown)
		}
	};

	const sessionIdOf = (ctx: { sessionManager?: { getSessionId?(): string } }): string => {
		try {
			return ctx.sessionManager?.getSessionId?.() ?? "";
		} catch {
			return "";
		}
	};

	const cwdOf = (ctx: { cwd?: string; sessionManager?: { getCwd?(): string } }): string => {
		try {
			return ctx.cwd ?? ctx.sessionManager?.getCwd?.() ?? process.cwd();
		} catch {
			return process.cwd();
		}
	};

	// ------------------------------------------------------------------
	// Session end: digest the session that just finished
	// ------------------------------------------------------------------
	pi.on("session_shutdown", (event, ctx) => {
		// Digest finished sessions: quit, new, and resume-away (the abandoned
		// file is finalized at teardown). "fork" continues in the copy and
		// "reload" keeps the session alive — neither must produce a digest.
		if (event.reason === "reload" || event.reason === "fork") return;
		try {
			// Ephemeral sessions (--no-session) have no session file; their
			// throwaway digests must not leak into the next real session.
			if (!ctx.sessionManager.getSessionFile?.()) return;
			const sessionId = sessionIdOf(ctx);
			if (!sessionId) return;
			const entries = ctx.sessionManager.getEntries() as unknown[];
			const header = ctx.sessionManager.getHeader?.() as { timestamp?: string } | undefined;
			const digest = buildDigest(entries, sessionId, cwdOf(ctx), new Date().toISOString(), header?.timestamp ?? "");
			saveDigest(dataDir, digest);
			// Keep a copy for /ouroboros digest — pending digests are
			// consumed at the next session start.
			saveLastDigest(dataDir, digest);
		} catch {
			// teardown race — best-effort
		}
	});

	pi.on("session_start", (event, ctx) => {
		uiHost = ctx as unknown as UiHost;
		reflectQueued = false;
		// Leftover .injected.json files mean the queued reflection was never
		// delivered (crash, quit before the first turn, failed LLM call) —
		// unmark them so the loop below re-injects them. A delivered
		// reflection has its marker deleted at agent_end. Skipped on reload:
		// the queued message survives in _pendingNextTurnMessages, and
		// unmarking would deliver the reflection twice.
		const recovered: string[] = [];
		if (event.reason !== "reload") {
			try {
				for (const sid of listInjectedDigests(dataDir)) {
					if (unmarkDigestInjected(dataDir, sid)) recovered.push(sid);
				}
				cleanupStaleTmp(dataDir);
			} catch {
				// best-effort — a failed cleanup must not block the reflection
			}
		}
		// The list is captured ONCE — a second call would re-sort. Recovered
		// digests (undelivered reflections) go FIRST so the newest-wins
		// delete cannot drop them in favor of a newer digest.
		const all = listDigests(dataDir);
		const ordered = [...recovered, ...all.filter((s) => !recovered.includes(s))];
		let injected = false;
		for (const sid of ordered) {
			// One corrupt digest must not block the rest.
			try {
				// Only the newest NOTABLE digest gets reflected on; the rest
				// are stale. Checked BEFORE loadDigest so a pile of pending
				// digests is deleted by filename without parsing.
				if (injected) {
					deleteDigest(dataDir, sid);
					continue;
				}
				const digest = loadDigest(dataDir, sid);
				if (!digest) {
					deleteDigest(dataDir, sid);
					continue;
				}
				if (!isNotable(digest, minPrompts)) {
					// Nothing worth reflecting on — don't burn tokens.
					deleteDigest(dataDir, sid);
					continue;
				}
				// Mark injected BEFORE sending: the rename is the atomic
				// claim. If it fails, another instance won — the digest is
				// theirs, so leave it alone.
				if (!markDigestInjected(dataDir, sid)) {
					continue;
				}
				try {
					pi.sendMessage(
						{
							customType: OUROBOROS_CUSTOM_TYPE,
							content: buildReflectionMessage(digest, rulesFile(dataDir), skillsDir(dataDir)),
							display: true,
						},
						{ deliverAs: "nextTurn" },
					);
				} catch {
					// sendMessage never throws in the current runtime, but if
					// it ever does, restore the digest for the next session
					// start instead of losing the reflection.
					unmarkDigestInjected(dataDir, sid);
					continue;
				}
				reflectQueued = true;
				hasInjectedDigests = true;
				injected = true;
			} catch {
				// One bad digest must not stall the rest.
			}
		}
		updateStatus();
	});
	pi.on("before_agent_start", (event) => {
		reflectQueued = false;
		const rules = loadRules(dataDir);
		if (rules.length === 0) return;
		return { systemPrompt: `${event.systemPrompt}${buildRulesAppendix(rules, rulesMaxChars)}` };
	});
	pi.on("agent_end", (event) => {
		// The queued reflection was delivered in this turn — the marker is
		// no longer needed. Deleted here (not before_agent_start): the LLM
		// call may fail after the message is drained, and the marker must
		// survive so the next session_start re-injects it. Skipped entirely
		// when nothing was injected (the common case): zero file IO per turn.
		if (hasInjectedDigests) {
			// A FAILED run (API down, auth error, retries exhausted) also
			// emits agent_end, with a message whose stopReason is
			// "error"/"aborted" (pi-agent-core agent.js handleRunFailure).
			// The reflection was NOT delivered — keep the marker.
			const messages = (event as { messages?: unknown[] }).messages ?? [];
			const last = messages[messages.length - 1] as { stopReason?: unknown } | undefined;
			if (last?.stopReason === "error" || last?.stopReason === "aborted") return;
			try {
				for (const sid of listInjectedDigests(dataDir)) {
					deleteInjectedDigest(dataDir, sid);
				}
			} catch {
				// best-effort — a failed cleanup must not skip the status
			}
			hasInjectedDigests = false;
			updateStatus();
		}
	});

	// ------------------------------------------------------------------
	// Tool: ouroboros_learn — record a lesson mid-session
	// ------------------------------------------------------------------

	pi.registerTool({
		name: "ouroboros_learn",
		label: "Ouroboros Learn",
		promptSnippet: "Record a self-learned lesson: a rule to follow or a skill to codify",
		promptGuidelines: [
			"ouroboros_learn: when you notice a mistake you made, or a rule that would have prevented it, record it immediately with kind=rule — it becomes active next turn.",
			"ouroboros_learn: for a reusable multi-step procedure, record it as kind=skill with a name, description, and full body.",
		],
		description: [
			"Record a self-learned lesson for future sessions.",
			"kind=rule: append an imperative rule to the ouroboros rules file; it is injected into the system prompt from the next turn on. Duplicates are skipped; the newest rules replace the oldest when at cap.",
			"kind=skill: write a skill (SKILL.md with name + description frontmatter) under the pi agent skills directory; pi discovers it automatically on the next startup.",
		].join(" "),
		parameters: Type.Object({
			lesson: Type.String({
				description: "The lesson: an imperative rule (e.g. 'Always re-read a file before editing it') or a description of the mistake and the fix",
			}),
			kind: StringEnum(["rule", "skill"] as const, {
				description: "rule=append to the active rules file; skill=write a SKILL.md",
			}),
			skillName: Type.Optional(
				Type.String({ description: "Skill name, lowercase letters/digits/hyphens (e.g. 'debug-flaky-tests') — required for kind=skill" }),
			),
			skillDescription: Type.Optional(Type.String({ description: "Skill description: what it does and when to use it — required for kind=skill" })),
			skillBody: Type.Optional(Type.String({ description: "Full SKILL.md body in markdown (no frontmatter) — required for kind=skill" })),
		}),
		renderCall(args, theme, context) {
			const kind = String(args.kind ?? "rule");
			const text = `ouroboros_learn ${kind}`;
			return new Text(theme.fg("toolTitle", theme.bold("ouroboros")) + theme.fg("dim", ` ${text.replace(/^ouroboros_learn /, "")}`), 1, 0);
		},
		renderResult(result, _options, theme, context) {
			const text = (Array.isArray(result.content) ? result.content : [])
				.filter((c) => typeof c === "object" && c !== null && "text" in c && typeof (c as { text?: unknown }).text === "string")
				.map((c) => (c as { text: string }).text)
				.join(" ")
				.replace(/\s+/g, " ")
				.trim()
				.slice(0, 120);
			return new Text(theme.fg("muted", text || "ok"), 1, 0);
		},
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (params.kind === "rule") {
				const { added, reason, count, cap } = appendRule(dataDir, params.lesson, rulesCap, rulesMaxChars);
				updateStatus();
				const text =
					reason === "duplicate"
						? `duplicate rule skipped (${count}/${cap})`
						: reason === "empty"
							? "rule not recorded — lesson is empty after normalization"
							: reason === "conflict"
								? `rule not recorded — concurrent write (${count}/${cap})`
								: `rule recorded (${count}/${cap}) — active from next turn`;
				return {
					content: [{ type: "text" as const, text }],
					details: { added, reason, count, cap },
				};
			}

			const name = params.skillName ?? "";
			const description = params.skillDescription ?? "";
			const body = params.skillBody ?? "";
			if (!isValidSkillName(name)) {
				throw new Error("skillName must be lowercase letters, digits, and hyphens (e.g. 'debug-flaky-tests')");
			}
			if (!description.trim()) throw new Error("skillDescription is required for kind=skill");
			if (!body.trim()) throw new Error("skillBody is required for kind=skill");
			// Bounds: the body is written verbatim and pi advertises the
			// description in the system prompt — a huge body is a disk-fill
			// vector and a huge description bloats every future prompt.
			if (description.length > 200) throw new Error("skillDescription must be 200 characters or fewer");
			if (body.length > 20_000) throw new Error("skillBody must be 20,000 characters or fewer");
			const file = writeSkill(dataDir, name, description, body);
			updateStatus();
			return {
				content: [{ type: "text" as const, text: `skill written to ${file} — discovered on next pi startup` }],
				details: { path: file },
			};
		},
	});

	// ------------------------------------------------------------------
	// /ouroboros command — status, force reflect, reset, digest
	// ------------------------------------------------------------------

	pi.registerCommand("ouroboros", {
		description: "Ouroboros: show self-learned rules/skills, force a reflection, reset rules, or show the last digest",
		handler: async (args, cmdCtx) => {
			uiHost = cmdCtx as unknown as UiHost;
			const sub = (args ?? "").trim().split(/\s+/)[0] ?? "";

			if (sub === "reset") {
				try {
					clearRules(dataDir);
					updateStatus();
					if (cmdCtx.hasUI) cmdCtx.ui.notify("ouroboros: rules cleared", "info");
				} catch (err) {
					if (cmdCtx.hasUI) cmdCtx.ui.notify(`ouroboros: reset failed: ${String(err)}`, "error");
				}
				return;
			}

			if (sub === "reflect") {
				if (reflectQueued) {
					if (cmdCtx.hasUI) cmdCtx.ui.notify("ouroboros: a reflection is already queued", "info");
					return;
				}
				try {
					// Mid-session: the model already has the session in
					// context, so no digest is included.
					pi.sendMessage(
						{
							customType: OUROBOROS_CUSTOM_TYPE,
							content: buildReflectionMessage(null, rulesFile(dataDir), skillsDir(dataDir), true),
							display: true,
						},
						{ deliverAs: "nextTurn" },
					);
					reflectQueued = true;
					if (cmdCtx.hasUI) cmdCtx.ui.notify("ouroboros: reflection queued for the next turn", "info");
				} catch (err) {
					if (cmdCtx.hasUI) cmdCtx.ui.notify(`ouroboros: reflection failed: ${String(err)}`, "error");
				}
				return;
			}

			if (sub === "digest") {
				// Pending digests are consumed at session start, so the
				// command reads the last-digest copy written at shutdown.
				const digest = loadLastDigest(dataDir);
				if (digest) {
					if (cmdCtx.hasUI) cmdCtx.ui.notify(formatDigest(digest), "info");
				} else if (existsSync(lastDigestFile(dataDir))) {
					if (cmdCtx.hasUI) cmdCtx.ui.notify("ouroboros: digest unreadable (corrupt file)", "error");
				} else if (cmdCtx.hasUI) {
					cmdCtx.ui.notify("ouroboros: no digest recorded yet", "info");
				}
				return;
			}

			// Default: status.
			const rules = loadRules(dataDir);
			const skills = listSkills(dataDir);
			const pending = listDigests(dataDir);
			const lines = [
				`ouroboros: ${rules.length} rules, ${skills.length} skills, ${pending.length} pending digest(s)`,
				`rules file: ${rulesFile(dataDir)}`,
			];
			if (rules.length > 0) {
				lines.push("", "last rules:");
				for (const r of rules.slice(-5)) lines.push(`- ${r}`);
			}
			if (cmdCtx.hasUI) cmdCtx.ui.notify(lines.join("\n"), "info");
		},
	});

	// No custom message renderer: pi's default CustomMessageComponent renders
	// the content as Markdown (label + body), which is better than a raw
	// Text dump for the numbered instructions.

	pi.on("session_shutdown", () => {
		try {
			uiHost?.ui.setStatus("ouroboros", undefined);
		} catch {
			// teardown race — best-effort
		}
		uiHost = undefined;
	});
}

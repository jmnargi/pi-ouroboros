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
	deleteDigest,
	listDigests,
	loadDigest,
	listSkills,
	loadRules,
	skillsDir,
	rulesFile,
	saveDigest,
	writeSkill,
	isValidSkillName,
} from "./persistence.ts";
import { buildReflectionMessage, buildRulesAppendix, formatDigest, OUROBOROS_CUSTOM_TYPE } from "./reflect.ts";

/** Minimal theme surface used by the message renderer. */
interface ThemeLike {
	fg(color: string, text: string): string;
	bold(text: string): string;
}

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

	const dataDir = process.env.PI_CODING_AGENT_DIR ?? (process.env.HOME ? `${process.env.HOME}/.pi/agent` : ".");
	const rulesCap = envInt("PI_OUROBOROS_RULES_CAP", DEFAULT_RULES_CAP);
	const rulesMaxChars = envInt("PI_OUROBOROS_RULES_MAX_CHARS", DEFAULT_RULES_MAX_CHARS);
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
			const parts = [`⟳ ${rules.length} rules`];
			if (skills.length > 0) parts.push(`${skills.length} skills`);
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
		} catch {
			// teardown race — best-effort
		}
	});

	pi.on("session_start", (_event, ctx) => {
		uiHost = ctx as unknown as UiHost;
		// Bounded scan: at most the newest 5 digests are ever loaded. Anything
		// older is stale (a digest is consumed on the first session start
		// after it is written) and is deleted by filename without parsing.
		const pending = listDigests(dataDir).slice(0, 5);
		let injected = false;
		for (const sid of pending) {
			// One corrupt digest must not block the rest.
			try {
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
				// Only the newest NOTABLE digest gets reflected on; older
				// ones (and non-notable ones) are stale.
				if (injected) {
					deleteDigest(dataDir, sid);
					continue;
				}
				// Mark injected BEFORE sending: if the rename fails, the
				// digest stays pending and the message is not queued.
				if (!markDigestInjected(dataDir, sid)) {
					deleteDigest(dataDir, sid);
					continue;
				}
				pi.sendMessage(
					{
						customType: OUROBOROS_CUSTOM_TYPE,
						content: buildReflectionMessage(digest, rulesFile(dataDir), skillsDir(dataDir)),
						display: true,
					},
					{ deliverAs: "nextTurn" },
				);
				reflectQueued = true;
				hasInjectedDigests = true;
				injected = true;
			} catch {
				// best-effort — one bad digest must not stall the rest
			}
		}
		// Delete any digests beyond the scan window without parsing them.
		for (const sid of listDigests(dataDir).slice(5)) {
			deleteDigest(dataDir, sid);
		}
		updateStatus();
	});

	pi.on("before_agent_start", (event) => {
		// The queued reflection is delivered in this turn — clean up any
		// injected digests that were never consumed. Skipped entirely when
		// nothing was injected (the common case): zero file IO per turn.
		if (hasInjectedDigests) {
			for (const sid of listInjectedDigests(dataDir)) {
				deleteInjectedDigest(dataDir, sid);
			}
			hasInjectedDigests = false;
		}
		reflectQueued = false;
		const rules = loadRules(dataDir);
		if (rules.length === 0) return;
		return { systemPrompt: `${event.systemPrompt}${buildRulesAppendix(rules, rulesMaxChars)}` };
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
				const { added, count, cap } = await appendRule(dataDir, params.lesson, rulesCap);
				updateStatus();
				return {
					content: [
						{
							type: "text" as const,
							text: added ? `rule recorded (${count}/${cap}) — active from next turn` : `duplicate rule skipped (${count}/${cap})`,
						},
					],
					details: { added, count, cap },
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
				clearRules(dataDir);
				updateStatus();
				if (cmdCtx.hasUI) cmdCtx.ui.notify("ouroboros: rules cleared", "info");
				return;
			}

			if (sub === "reflect") {
				if (reflectQueued) {
					if (cmdCtx.hasUI) cmdCtx.ui.notify("ouroboros: a reflection is already queued", "info");
					return;
				}
				try {
					const entries = cmdCtx.sessionManager.getEntries() as unknown[];
					const digest = buildDigest(entries, sessionIdOf(cmdCtx), cwdOf(cmdCtx), new Date().toISOString());
					pi.sendMessage(
						{
							customType: OUROBOROS_CUSTOM_TYPE,
							content: buildReflectionMessage(digest, rulesFile(dataDir), skillsDir(dataDir), true),
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
				const pending = listDigests(dataDir);
				if (pending.length === 0) {
					if (cmdCtx.hasUI) cmdCtx.ui.notify("ouroboros: no pending digests", "info");
					return;
				}
				const digest = loadDigest(dataDir, pending[0]!);
				if (cmdCtx.hasUI) cmdCtx.ui.notify(digest ? formatDigest(digest) : "ouroboros: digest unreadable", "info");
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

	// ------------------------------------------------------------------
	// TUI rendering for the reflection message
	// ------------------------------------------------------------------

	pi.registerMessageRenderer(OUROBOROS_CUSTOM_TYPE, (message, _options, theme) => {
		const t = theme as unknown as ThemeLike;
		const head = t.fg("accent", t.bold("⟳ ouroboros"));
		const content = typeof message.content === "string" ? message.content : "";
		return new Text(`${head}\n${content}`, 1, 0);
	});

	pi.on("session_shutdown", () => {
		try {
			uiHost?.ui.setStatus("ouroboros", undefined);
		} catch {
			// teardown race — best-effort
		}
		uiHost = undefined;
	});
}

/**
 * pi-ouroboros — self-improving pi coding agent.
 *
 * The loop:
 *  1. Session end. The plugin writes a compact digest of the session to
 *     `<agentDir>/ouroboros/digests/<sessionId>.json`. The digest contains
 *     user prompts, failed tool calls, failed commands, stop reasons,
 *     compaction pressure, and usage.
 *  2. Next session start. If a pending digest is notable, the plugin queues
 *     a reflection message (deliverAs "nextTurn"). The agent extracts lessons
 *     from its own past as part of its first turn. There is no startup delay
 *     and no extra API call. The plugin consumes the digest after injection.
 *  3. Every turn. The plugin appends self-learned rules from
 *     `<agentDir>/ouroboros/rules.md` to the system prompt. A lesson recorded
 *     mid-session is active the very next turn.
 *  4. `ouroboros_learn` lets the agent record a lesson immediately. kind=rule
 *     appends to rules.md (deduped, capped). kind=skill writes a SKILL.md
 *     that pi auto-discovers on the next startup.
 *
 * The agent does the reflection itself (in its own loop, with its own tools).
 * Ouroboros does only deterministic digesting, file IO, and prompt
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
	readInjectedDigest,
	listSkills,
	loadRules,
	rulesFile,
	saveDigest,
	writeSkill,
	isValidSkillName,
	cleanupStaleTmp,
	loadLastDigest,
	lastDigestFile,
	saveLastDigest,
} from "./persistence.ts";
import { buildReflectionMessage, buildRulesAppendix, escapeTags, formatDigest, OUROBOROS_CUSTOM_TYPE } from "./reflect.ts";







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

/** True when the session entries already contain the reflection for digest
 * `sessionId`. The message is drained (persisted) before the first LLM call.
 * A failed first turn leaves it in the history with the marker still set.
 * Re-injecting on resume would deliver the reflection twice.
 * The content is matched per-digest (`session: <sessionId>` in the digest
 * block). An OLD ouroboros message from a prior successful reflection cannot
 * mask an undelivered one. The entries come from the runtime's own parsed
 * session (ctx.sessionManager.getEntries()) — complete, bounded, no file IO. */
function sessionHasOuroborosMessage(entries: unknown[], sessionId: string): boolean {
	// Match the digest-block line, not a bare substring.
	// A reflection for a different digest must not count as delivered.
	// Its data can contain 'session: <this id>' (for example, a user prompt
	// '- session: A'). The real block always renders `\nsession: <id>\n` as
	// its first line, with '<' escaped exactly as formatDigest does — the
	// needle must match the RENDERED form.
	const needle = `\nsession: ${escapeTags(sessionId)}\n`;
	for (const raw of entries) {
		if (!raw || typeof raw !== "object") continue;
		const entry = raw as { type?: unknown; customType?: unknown; content?: unknown };
		if (entry.type === "custom_message" && entry.customType === OUROBOROS_CUSTOM_TYPE && typeof entry.content === "string" && entry.content.includes(needle)) {
			return true;
		}
	}
	return false;
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
	/** Sids actually queued in the current session_start. agent_end deletes
	 * ONLY these markers — a recovered-but-not-queued digest keeps its marker
	 * (the atomic claim) for the next session start. */
	let queuedInjected = new Set<string>();
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
			// temporary digests must not leak into the next real session.
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

	pi.on("session_start", async (event, ctx) => {
		uiHost = ctx as unknown as UiHost;
		reflectQueued = false;
		queuedInjected = new Set();
		// Reset the stale flag: a previous session's failed run can leave it
		// true, and a spurious marker-deletion pass at the next agent_end
		// would do an unnecessary readdir.
		hasInjectedDigests = false;
		// Leftover .injected.json files mean the queued reflection was never
		// confirmed delivered (crash, quit before the first turn, failed LLM
		// call). Keep their markers (the atomic claim) and process them
		// directly from the injected state below. A delivered reflection has
		// its marker deleted at agent_end.
		const recovered: string[] = [];
		if (event.reason !== "reload") {
			try {
				const injected = listInjectedDigests(dataDir);
				if (injected.length > 0) {
					// The queued reflection can already be in the CURRENT
					// session's history: the message is drained (persisted)
					// before the first LLM call, and a failed call keeps the
					// marker. This fires for every non-reload reason — the
					// primary resume path (pi --continue/--resume) emits
					// reason "startup", not "resume". If the history already
					// has the reflection for this digest, delete the marker
					// instead of re-injecting — that would deliver it twice.
					// The entries come from the runtime's parsed session
					// (complete, no file IO).
					const entries = (ctx as unknown as { sessionManager?: { getEntries?: () => unknown[] } }).sessionManager?.getEntries?.() ?? [];
					for (const sid of injected) {
						// Per-digest isolation: a transient IO error on one
						// marker (EMFILE, EACCES) must not stall the rest —
						// the marker is kept for the next session start.
						let digest: OuroborosDigest | null = null;
						try {
							digest = readInjectedDigest(dataDir, sid);
						} catch {
							continue;
						}
						const alreadyDelivered = digest ? sessionHasOuroborosMessage(entries, digest.sessionId) : false;
						if (alreadyDelivered) {
							deleteInjectedDigest(dataDir, sid);
						} else {
							// Keep the marker (the atomic claim) and process
							// the digest directly from the injected state.
							// Unmarking would open a pending window in which
							// a concurrent instance could delete the digest
							// as stale before it is re-injected.
							recovered.push(sid);
						}
					}
				}
				cleanupStaleTmp(dataDir);
			} catch {
				// best-effort — a failed cleanup must not block the reflection
			}
		} else {
			// Reload re-imports the extension module (fresh state) but keeps
			// the AgentSession — the queued message survives in
			// _pendingNextTurnMessages. Reconcile the markers: a marker whose
			// reflection is already in the session history was delivered
			// before the reload (delete it). The rest are left alone — a
			// marker can also be a recovered-but-not-queued digest (kept as
			// the atomic claim from a prior session_start), whose reflection
			// is NOT queued; deleting it at agent_end would lose it. The
			// next session start's recovery reconciles the delivered ones.
			try {
				const entries = (ctx as unknown as { sessionManager?: { getEntries?: () => unknown[] } }).sessionManager?.getEntries?.() ?? [];
				for (const sid of listInjectedDigests(dataDir)) {
					const digest = readInjectedDigest(dataDir, sid);
					if (digest && sessionHasOuroborosMessage(entries, digest.sessionId)) {
						deleteInjectedDigest(dataDir, sid);
					} else {
						// A marker remains: agent_end must check the run's
						// messages and delete any marker whose reflection
						// was actually delivered in this run.
						hasInjectedDigests = true;
					}
				}
			} catch {
				// best-effort — a failed cleanup must not block the session
			}
		}
		// Recovered digests keep their markers (still injected), so they are
		// NOT in `all` (which lists pending digests only). They go FIRST,
		// mtime-sorted newest-first (listInjectedDigests sorts), so the
		// freshest undelivered reflection is injected. Pending digests follow.
		const all = listDigests(dataDir);
		const recoveredSet = new Set(recovered);
		const ordered = [...recovered, ...all.filter((s) => !recoveredSet.has(s))];
		let injected = false;
		for (const sid of ordered) {
			// One corrupt digest must not stall the rest.
			try {
				if (injected) {
					// Recovered digests keep their markers (still claimed) —
					// they are re-processed at the next session start.
					// Pending digests are stale once one reflection is queued.
					if (!recoveredSet.has(sid)) deleteDigest(dataDir, sid);
					continue;
				}
				const digest = recoveredSet.has(sid) ? readInjectedDigest(dataDir, sid) : loadDigest(dataDir, sid);
				if (!digest) {
					if (recoveredSet.has(sid)) deleteInjectedDigest(dataDir, sid);
					else deleteDigest(dataDir, sid);
					continue;
				}
				if (!isNotable(digest, minPrompts)) {
					// Nothing worth reflecting on — do not waste tokens.
					if (recoveredSet.has(sid)) deleteInjectedDigest(dataDir, sid);
					else deleteDigest(dataDir, sid);
					continue;
				}
				// Pending digests are claimed with the rename (the atomic
				// claim). Recovered digests are already claimed.
				if (!recoveredSet.has(sid) && !markDigestInjected(dataDir, sid)) {
					continue;
				}
				try {
					await pi.sendMessage(
						{
							customType: OUROBOROS_CUSTOM_TYPE,
							content: buildReflectionMessage(digest),
							display: true,
						},
						{ deliverAs: "nextTurn" },
					);
				} catch {
					// sendMessage never throws in the current runtime, but if
					// it ever does, restore the digest for the next session
					// start instead of losing the reflection. Recovered
					// digests keep their marker (still claimed).
					if (!recoveredSet.has(sid)) unmarkDigestInjected(dataDir, sid);
					continue;
				}
				reflectQueued = true;
				hasInjectedDigests = true;
				queuedInjected.add(sid);
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
		// The queued reflection was delivered in this turn.
		// The marker is no longer needed.
		// The plugin deletes it here, not at before_agent_start.
		// The LLM call can fail after the message drains.
		// The marker must survive so the next session_start re-injects it.
		// Skipped entirely when nothing was injected (the common case):
		// zero file IO per turn.
		if (hasInjectedDigests) {
			// A FAILED run (API down, auth error, retries exhausted) also
			// emits agent_end, with a message whose stopReason is
			// "error"/"aborted" (pi-agent-core agent.js handleRunFailure).
			// The reflection was NOT delivered — keep the marker.
			const messages = (event as { messages?: unknown[] }).messages ?? [];
			const last = messages[messages.length - 1] as { stopReason?: unknown } | undefined;
			if (last?.stopReason === "error" || last?.stopReason === "aborted") return;
			try {
				// Delete ONLY the markers queued in this session_start. A
				// recovered-but-not-queued digest (sendMessage failure, or a
				// second recovered digest skipped because one was already
				// injected) keeps its marker — the atomic claim — for the
				// next session start.
				for (const sid of queuedInjected) {
					deleteInjectedDigest(dataDir, sid);
				}
				// A reload re-imported the module, so a marker queued before
				// the reload is not in queuedInjected. Delete any injected
				// marker whose reflection is verifiably in THIS run's
				// messages — the drained custom message carries the digest
				// block. A marker whose reflection is not in the messages
				// (recovered-but-not-queued) is left for the next recovery.
				for (const sid of listInjectedDigests(dataDir)) {
					const digest = readInjectedDigest(dataDir, sid);
					if (!digest) continue;
					const needle = `\nsession: ${escapeTags(digest.sessionId)}\n`;
					const delivered = messages.some((m) => {
						const content = (m as { content?: unknown })?.content;
						return typeof content === "string" && content.includes(needle);
					});
					if (delivered) deleteInjectedDigest(dataDir, sid);
				}
			} catch {
				// best-effort — a failed cleanup must not skip the status
			}
			queuedInjected = new Set();
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
			"kind=rule: append an imperative rule to the ouroboros rules file. The plugin injects it into the system prompt from the next turn on. The plugin skips duplicates. The newest rules replace the oldest when at cap.",
			"kind=skill: write a skill (SKILL.md with name + description frontmatter) under the pi agent skills directory. Pi discovers it automatically on the next startup.",
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
			// vector and a huge description enlarges every future prompt.
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
							content: buildReflectionMessage(null, true),
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
				`ouroboros: ${rules.length} rules, ${skills.length} skill${skills.length === 1 ? "" : "s"}, ${pending.length} pending digest(s)`,
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

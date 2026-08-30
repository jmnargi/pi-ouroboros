/**
 * src/digest.ts — session → digest extraction (pure, no pi imports).
 *
 * A digest is a compact, lossy summary of a session.
 * It is cheap enough to hand back to the model for reflection.
 * It contains user prompts, failed tool calls, failed bash commands,
 * assistant stop reasons, compaction pressure, and token/cost totals.
 * The plugin deliberately drops everything else: thinking traces, full
 * outputs, and tool arguments.
 *
 * The extractor is defensive.
 * It walks unknown entry shapes with optional chaining.
 * It never throws on a malformed entry.
 * A corrupt session must degrade to an empty digest, not crash the shutdown
 * hook.
 * Session entry shape (verified against real pi.dev 0.82.1 session files):
 * every message is `{ type: "message", message: AgentMessage }`.
 *   - Tool results: `message.role === "toolResult"` with `isError`/`toolName`
 *     on the message object.
 *   - Bash tool calls: stored as toolResult with `toolName: "bash"`. A real
 *     failure has `isError: true` and text ending "Command exited with code
 *     N" (the tool throws); a success has `isError: false` and no exit code.
 *     The command text lives on the preceding assistant toolCall (matched by
 *     toolCallId).
 *   - The documented `bashExecution` role (command/exitCode on the message)
 *     is also handled, for other bash paths and future versions.
 *
 * Digest content is UNTRUSTED DATA: it can contain text from files, tools,
 * and other agents. Control characters are stripped so it cannot smuggle
 * formatting or instructions into the reflection message.
 */

export interface OuroborosDigest {
	version: 1;
	sessionId: string;
	cwd: string;
	startedAt: string;
	endedAt: string;
	/** User prompts, newest-last, each truncated. */
	userPrompts: string[];
	/** Uncapped count of user prompts (userPrompts is capped at PROMPT_CAP). */
	userPromptCount: number;
	/** Assistant tool calls (name + truncated key args), newest-last — the
	 * reflection needs to see what the model actually DID, not just failures. */
	toolCalls: Array<{ tool: string; args: string }>;
	/** Assistant text messages, newest-last, each truncated. */
	assistantText: string[];
	/** Failed tool results: tool name + brief text. */
	errors: Array<{ tool: string; summary: string }>;
	/** Bash commands that exited non-zero, with the error tail. */
	failedCommands: Array<{ command: string; error: string }>;
	/** Assistant stop-reason counts (e.g. { stop: 4, length: 1 }). */
	stopReasons: Record<string, number>;
	/** Distinct model ids used. */
	models: string[];
	/** Number of compaction entries. */
	compactions: number;
	usage: { input: number; output: number; cost: number };
	messageCount: number;
}

/** Per-prompt / per-error text cap — digests must stay small. */
export const PROMPT_CAP = 12;
export const PROMPT_MAX_CHARS = 240;
export const ERROR_MAX_CHARS = 160;
export const COMMAND_MAX_CHARS = 160;
export const ERROR_CAP = 20;
export const COMMAND_CAP = 20;
export const TOOL_CALL_CAP = 20;
export const TOOL_ARGS_MAX_CHARS = 80;
export const ASSISTANT_TEXT_CAP = 12;

/** Stop reasons that do not indicate a problem (benign). */
const BENIGN_STOP_REASONS: Record<string, true> = { stop: true, toolUse: true };

/** Minimal structural view of a session entry (defensive). */
interface RawEntry {
	type?: unknown;
	message?: {
		role?: unknown;
		content?: unknown;
		stopReason?: unknown;
		model?: unknown;
		usage?: { input?: unknown; output?: unknown; cost?: { total?: unknown } };
		isError?: unknown;
		toolName?: unknown;
		toolCallId?: unknown;
		command?: unknown;
		exitCode?: unknown;
		output?: unknown;
	};
	cwd?: unknown;
	id?: unknown;
	timestamp?: unknown;
}

/** Extract plain text from a message content (string or content blocks). */
export function extractText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		if (!block || typeof block !== "object") continue;
		const b = block as { type?: unknown; text?: unknown; name?: unknown; arguments?: unknown };
		if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
		else if (b.type === "toolCall" && typeof b.name === "string") {
			parts.push(`[tool:${b.name}]`);
		}
	}
	return parts.join("\n");
}
function truncate(s: string, max: number): string {
	// Cleaning removes characters, so the first max code points of the
	// cleaned text can start arbitrarily far into the input. Grow the bound
	// geometrically until enough survive or the string is exhausted — the
	// common case (no control chars) is one pass over ~max*2 units.
	let bound = max * 2 + 1;
	let cleaned = "";
	while (true) {
		cleaned = s
			.slice(0, bound)
			.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u2028\u2029]/g, "")
			.trim()
			.replace(/\s+/g, " ");
		if (Array.from(cleaned).length > max || bound >= s.length) break;
		bound = Math.min(s.length, bound * 2);
	}
	if (Array.from(cleaned).length <= max) return cleaned;
	// Cut by code points, never mid-surrogate-pair (emoji must survive).
	const chars = Array.from(cleaned);
	return `${chars.slice(0, max).join("")}…`;
}

/** Keep the LAST max code points — bash errors put the exit code at the end. */
function truncateTail(s: string, max: number): string {
	const cleaned = s
		.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u2028\u2029]/g, "")
		.trim()
		.replace(/\s+/g, " ");
	const chars = Array.from(cleaned);
	if (chars.length <= max) return cleaned;
	return `…${chars.slice(-max).join("")}`;
}

function asNumber(v: unknown): number {
	return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/**
 * Build a digest from raw session entries. `sessionId`/`cwd` fall back to the
 * session header entry when present; `endedAt` is the caller-provided wall
 * clock (the shutdown moment); `startedAt` is the caller-provided header
 * timestamp when available.
 */
export function buildDigest(
	entries: unknown[],
	sessionId: string,
	cwd: string,
	endedAt: string,
	startedAt: string = "",
): OuroborosDigest {
	const digest: OuroborosDigest = {
		version: 1,
		sessionId,
		cwd,
		startedAt,
		endedAt,
		userPrompts: [],
		userPromptCount: 0,
		toolCalls: [],
		assistantText: [],
		errors: [],
		failedCommands: [],
		stopReasons: {},
		models: [],
		compactions: 0,
		usage: { input: 0, output: 0, cost: 0 },
		messageCount: 0,
	};

	const seenModels = new Set<string>();
	const seenErrors = new Set<string>();
	const seenCommands = new Set<string>();
	/** toolCallId → bash command, from assistant toolCalls. */
	const bashCommands = new Map<string, string>();
	/** Raw (unstringified) trace buffers — stringify only the kept calls. */
	const rawToolCalls: Array<{ tool: string; args: unknown }> = [];
	const rawAssistantText: string[] = [];

	for (const raw of entries) {
		if (!raw || typeof raw !== "object") continue;
		const entry = raw as RawEntry;

		// Session header (present in tests; getEntries() excludes it in pi).
		if (entry.type === "session") {
			if (typeof entry.cwd === "string" && entry.cwd) digest.cwd = entry.cwd;
			if (typeof entry.id === "string" && entry.id) digest.sessionId = entry.id;
			if (typeof entry.timestamp === "string" && entry.timestamp) digest.startedAt = entry.timestamp;
			continue;
		}

		// Compaction pressure.
		if (entry.type === "compaction") {
			digest.compactions += 1;
			continue;
		}

		if (entry.type !== "message" || !entry.message || typeof entry.message !== "object") continue;
		const msg = entry.message;
		digest.messageCount += 1;
		// Documented bashExecution role (command/exitCode on the message).
		if (msg.role === "bashExecution") {
			const code = asNumber(msg.exitCode);
			if (code !== 0 && typeof msg.command === "string" && msg.command.trim()) {
				// Dedup on the RAW command — truncation could collapse two
				// distinct commands into one key.
				const raw = msg.command.trim();
				if (!seenCommands.has(raw)) {
					seenCommands.add(raw);
					const cmd = truncate(raw, COMMAND_MAX_CHARS);
					const error = truncateTail(extractText(msg.output), ERROR_MAX_CHARS) || "(no output)";
					digest.failedCommands.push({ command: cmd, error });
				}
			}
			continue;
		}

		if (msg.role === "user") {
			digest.userPromptCount += 1;
			const text = truncate(extractText(msg.content), PROMPT_MAX_CHARS);
			if (text) digest.userPrompts.push(text);
			continue;
		}
		if (msg.role === "assistant") {
			if (typeof msg.stopReason === "string" && msg.stopReason) {
				digest.stopReasons[msg.stopReason] = (digest.stopReasons[msg.stopReason] ?? 0) + 1;
			}
			if (typeof msg.model === "string" && msg.model && !seenModels.has(msg.model)) {
				seenModels.add(msg.model);
				digest.models.push(msg.model);
			}
			const usage = msg.usage;
			if (usage) {
				digest.usage.input += asNumber(usage.input);
				digest.usage.output += asNumber(usage.output);
				digest.usage.cost += asNumber(usage.cost?.total);
			}
			// Remember bash commands so their tool results can be attributed.
			// Bounded: a long session must not grow this map without limit.
			if (Array.isArray(msg.content)) {
				for (const block of msg.content) {
					if (!block || typeof block !== "object") continue;
					const b = block as { type?: unknown; name?: unknown; id?: unknown; text?: unknown; arguments?: { command?: unknown } };
					if (b.type === "toolCall" && b.name === "bash" && typeof b.id === "string" && typeof b.arguments?.command === "string") {
						bashCommands.set(b.id, b.arguments.command);
						if (bashCommands.size > 100) {
							const oldest = bashCommands.keys().next().value;
							if (oldest !== undefined) bashCommands.delete(oldest);
						}
					}
					// Assistant trace: what the model actually DID, so the
					// reflection can see silent mistakes (wrong file edited,
					// destructive command that succeeded). Bounded DURING the
					// loop (shift+push keeps the newest) so a 10k-call
					// session does not build a 10k-element array.
					if (b.type === "toolCall" && typeof b.name === "string") {
						if (rawToolCalls.length >= TOOL_CALL_CAP) rawToolCalls.shift();
						rawToolCalls.push({ tool: b.name, args: b.arguments });
					} else if (b.type === "text" && typeof b.text === "string" && b.text.trim()) {
						if (rawAssistantText.length >= ASSISTANT_TEXT_CAP) rawAssistantText.shift();
						rawAssistantText.push(b.text);
					}
				}
			}
			continue;
		}

		if (msg.role === "toolResult") {
			// Real bash failures: the tool throws, so isError is true and the
			// text ends with "Command exited with code N". A command that
			// merely PRINTS "exit code: 5" (e.g. `echo "exit code: 5"`) exits
			// 0 with isError false — it is not a failure.
			if (msg.toolName === "bash") {
				if (msg.isError === true) {
					const raw = typeof msg.toolCallId === "string" ? bashCommands.get(msg.toolCallId) : undefined;
					const key = raw ?? "(unknown command)";
					if (!seenCommands.has(key)) {
						seenCommands.add(key);
						const cmd = truncate(key, COMMAND_MAX_CHARS);
						const error = truncateTail(extractText(msg.content), ERROR_MAX_CHARS) || "(no output)";
						digest.failedCommands.push({ command: cmd, error });
					}
				}
				continue;
			}

			// Other failed tools: isError/toolName on the message object.
			if (msg.isError === true) {
				const tool = typeof msg.toolName === "string" ? msg.toolName : "tool";
				const summary = truncate(extractText(msg.content), ERROR_MAX_CHARS) || "(no output)";
				const key = `${tool}:${summary}`;
				if (!seenErrors.has(key)) {
					seenErrors.add(key);
					digest.errors.push({ tool, summary });
				}
			}
			continue;
		}
	}

	// Keep the newest prompts; cap the rest.
	if (digest.userPrompts.length > PROMPT_CAP) {
		digest.userPrompts = digest.userPrompts.slice(-PROMPT_CAP);
	}
	// Cap failures too — a failure-heavy session must not blow up the digest.
	if (digest.errors.length > ERROR_CAP) {
		digest.errors = digest.errors.slice(-ERROR_CAP);
	}
	if (digest.failedCommands.length > COMMAND_CAP) {
		digest.failedCommands = digest.failedCommands.slice(-COMMAND_CAP);
	}
	// Stringify the kept trace calls (the raw buffers are already bounded).
	for (const t of rawToolCalls) {
		const args = typeof t.args === "object" && t.args !== null ? JSON.stringify(t.args) : "";
		digest.toolCalls.push({ tool: t.tool, args: truncate(args, TOOL_ARGS_MAX_CHARS) });
	}
	for (const t of rawAssistantText) {
		digest.assistantText.push(truncate(t, PROMPT_MAX_CHARS));
	}

	return digest;
}

/** True when the digest contains something worth reflecting on. */
export function isNotable(digest: OuroborosDigest, minPrompts: number): boolean {
	if (digest.errors.length > 0) return true;
	if (digest.failedCommands.length > 0) return true;
	// Benign stop reasons (stop/toolUse) fire on every normal turn — only
	// abnormal ones (length, error, aborted) make a session notable.
	const hasAbnormalStop = Object.keys(digest.stopReasons).some((k) => !BENIGN_STOP_REASONS[k]);
	if (hasAbnormalStop) return true;
	if (digest.compactions > 0) return true;
	// A long successful session is worth reflecting on, but only well above
	// the default threshold — without a failure signal the model writes
	// platitudes. userPromptCount is uncapped (userPrompts is capped at 12).
	return digest.userPromptCount >= Math.max(minPrompts, 20);
}


/**
 * src/digest.ts — session → digest extraction (pure, no pi imports).
 *
 * A digest is a compact, lossy summary of a session that is cheap enough to
 * hand back to the model for reflection: user prompts, failed tool calls,
 * failed bash commands, assistant stop reasons, compaction pressure, and
 * token/cost totals. Everything else (thinking traces, full outputs, tool
 * arguments) is deliberately dropped.
 *
 * The extractor is defensive: it walks unknown entry shapes with optional
 * chaining and never throws on a malformed entry — a corrupt session must
 * degrade to an empty digest, not crash the shutdown hook.
 *
 * Session entry shape (verified against real pi.dev 0.82.1 session files):
 * every message is `{ type: "message", message: AgentMessage }`.
 *   - Tool results: `message.role === "toolResult"` with `isError`/`toolName`
 *     on the message object.
 *   - Bash tool calls: stored as toolResult with `toolName: "bash"` and the
 *     exit code embedded in the text content ("exit code: N"); the command
 *     text lives on the preceding assistant toolCall (matched by toolCallId).
 *   - The documented `bashExecution` role (command/exitCode on the message)
 *     is also handled, for other bash paths and future versions.
 */

export interface OuroborosDigest {
	version: 1;
	sessionId: string;
	cwd: string;
	startedAt: string;
	endedAt: string;
	/** User prompts, newest-last, each truncated. */
	userPrompts: string[];
	/** Failed tool results: tool name + brief text. */
	errors: Array<{ tool: string; summary: string }>;
	/** Bash commands that exited non-zero, truncated. */
	failedCommands: string[];
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

/** Matches "exit code: 1" / "exit code 2" / "exit code: 0" in bash output. */
const EXIT_CODE_RE = /exit code:?\s*(\d+)/i;

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
	const t = s.trim().replace(/\s+/g, " ");
	return t.length > max ? `${t.slice(0, max)}…` : t;
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
				const cmd = truncate(msg.command, COMMAND_MAX_CHARS);
				if (!seenCommands.has(cmd)) {
					seenCommands.add(cmd);
					digest.failedCommands.push(cmd);
				}
			}
			continue;
		}

		if (msg.role === "user") {
			const text = extractText(msg.content).trim();
			if (text) digest.userPrompts.push(truncate(text, PROMPT_MAX_CHARS));
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
			if (Array.isArray(msg.content)) {
				for (const block of msg.content) {
					if (!block || typeof block !== "object") continue;
					const b = block as { type?: unknown; name?: unknown; id?: unknown; arguments?: { command?: unknown } };
					if (b.type === "toolCall" && b.name === "bash" && typeof b.id === "string" && typeof b.arguments?.command === "string") {
						bashCommands.set(b.id, b.arguments.command);
					}
				}
			}
			continue;
		}

		if (msg.role === "toolResult") {
			// Bash tool results carry the exit code in the text content.
			if (msg.toolName === "bash") {
				const text = extractText(msg.content);
				const match = EXIT_CODE_RE.exec(text);
				if (match && match[1] !== "0") {
					const command = typeof msg.toolCallId === "string" ? bashCommands.get(msg.toolCallId) : undefined;
					const cmd = truncate(command ?? "(unknown command)", COMMAND_MAX_CHARS);
					if (!seenCommands.has(cmd)) {
						seenCommands.add(cmd);
						digest.failedCommands.push(cmd);
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

	return digest;
}

/** True when the digest contains something worth reflecting on. */
export function isNotable(digest: OuroborosDigest, minPrompts: number): boolean {
	if (digest.errors.length > 0) return true;
	if (digest.failedCommands.length > 0) return true;
	if (Object.keys(digest.stopReasons).length > 0) return true;
	if (digest.compactions > 0) return true;
	return digest.userPrompts.length >= minPrompts;
}

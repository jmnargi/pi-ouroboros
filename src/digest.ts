/**
 * src/digest.ts — session → digest extraction (pure, no pi imports).
 *
 * A digest is a compact, lossy summary of a session.
 * It is small enough to give to the model for reflection.
 * It contains user prompts, failed tool calls, failed bash commands,
 * assistant stop reasons, compaction pressure, and token/cost totals.
 * The plugin deliberately drops everything else: thinking traces, full
 * outputs, and full tool arguments.
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
 *     N". A success has `isError: false` and no exit code.
 *     The command text is stored on the preceding assistant toolCall
 *     (matched by toolCallId).
 *   - The documented `bashExecution` role (command/exitCode on the message)
 *     is also handled, for other bash paths and future versions.
 *
 * Digest content is UNTRUSTED DATA: it can contain text from files, tools,
 * and other agents. Control characters are stripped so they cannot insert
 * formatting or instructions into the reflection message.
 */

/** A lone surrogate (a UTF-16 slice artifact) — stripped so writer output
 * always passes the validator's LONE_SURROGATE check. */
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;

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
	/** Assistant tool calls (name + truncated key args), newest-last. The
	 * reflection needs to see what the model did, not just failures. */
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
export const TOOL_NAME_MAX_CHARS = 100;
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
/** Count code points, stopping at max+1 — never materializes the array. */
function cpCountAtMost(s: string, max: number): number {
	let n = 0;
	for (const _ of s) {
		if (++n > max) return n;
	}
	return n;
}

/** The first max code points, without materializing the whole string. */
function cpPrefix(s: string, max: number): string {
	if (s.length <= max) return s; // fast path: units <= max implies code points <= max
	let out = "";
	let n = 0;
	for (const ch of s) {
		if (n >= max) break;
		out += ch;
		n++;
	}
	return out;
}

/** The last max code points, without materializing the whole string.
 * O(max) iterations and O(max) copies. The code points are collected in
 * reverse order and joined once. */
function cpSuffix(s: string, max: number): string {
	if (s.length <= max) return s; // fast path
	// Walk backwards by code points: a low surrogate at i-1 means the code
	// point starts at i-2 (never split a pair).
	const parts: string[] = [];
	let i = s.length;
	let n = 0;
	while (i > 0 && n < max) {
		const code = s.charCodeAt(i - 1);
		if (code >= 0xdc00 && code <= 0xdfff && i >= 2) {
			const hi = s.charCodeAt(i - 2);
			if (hi >= 0xd800 && hi <= 0xdbff) {
				parts.push(s.slice(i - 2, i));
				i -= 2;
			} else {
				parts.push(s.slice(i - 1, i));
				i -= 1;
			}
		} else {
			parts.push(s.slice(i - 1, i));
			i -= 1;
		}
		n++;
	}
	parts.reverse();
	return parts.join("");
}

function truncate(s: string, max: number): string {
	// Cleaning removes characters. The first max code points of the
	// cleaned text can start arbitrarily far into the input. Grow the
	// bound geometrically until enough survive or the string is exhausted.
	// The count and the final cut are O(max), never O(n). A 10MB input
	// must not materialize a 10M-element array.
	let bound = max * 2 + 1;
	let cleaned = "";
	while (true) {
		cleaned = s
			.slice(0, bound)
			.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f]/g, "")
			.replace(LONE_SURROGATE, "")
			.trim()
			.replace(/\s+/g, " ");
		if (cpCountAtMost(cleaned, max) > max || bound >= s.length) break;
		bound = Math.min(s.length, bound * 2);
	}
	if (cpCountAtMost(cleaned, max) <= max) return cleaned;
	return `${cpPrefix(cleaned, max)}…`;
}

/** Lightweight sanitizer for short identifiers (tool names, models):
 * strips the same control-char class the validator rejects (plus lone
 * surrogates), then slices. Cheaper than truncate (no whitespace collapse,
 * no ellipsis). The fast path (short names) avoids Array.from; only
 * over-long names pay for the code-point cut (never mid-surrogate-pair). */
function cleanName(s: string, max: number): string {
	const cleaned = s
		.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f]/g, "")
		.replace(LONE_SURROGATE, "");
	if (cleaned.length <= max) return cleaned;
	return Array.from(cleaned).slice(0, max).join("");
}

/** Keep the LAST max code points — bash errors put the exit code at the end.
 * Bound the input before the code-point pass. A 10MB tool output must not
 * materialize a 10M-element array. Grow the tail bound geometrically until
 * enough code points survive or the string is exhausted. The count and the
 * final cut are O(max), never O(n). */
function truncateTail(s: string, max: number): string {
	let bound = max * 2 + 1;
	let cleaned = "";
	while (true) {
		cleaned = s
			.slice(-bound)
			.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f]/g, "")
			.replace(LONE_SURROGATE, "")
			.trim()
			.replace(/\s+/g, " ");
		if (cpCountAtMost(cleaned, max) > max || bound >= s.length) break;
		bound = Math.min(s.length, bound * 2);
	}
	if (cpCountAtMost(cleaned, max) <= max) return cleaned;
	return `…${cpSuffix(cleaned, max)}`;
}

function asNumber(v: unknown): number {
	return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/**
 * Build a digest from raw session entries. `sessionId`/`cwd` fall back to
 * the session header entry when present. `endedAt` is the caller-provided
 * wall clock. `startedAt` is the caller-provided header timestamp when
 * available.
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
		// Sanitize the parameters here, not in the session-header branch.
		// getEntries() excludes session entries in the real runtime. The
		// production path passes raw values. A control char in the project
		// directory name must not make the digest fail validation on load.
		sessionId: cleanName(sessionId, 200),
		cwd: cleanName(cwd, 2000),
		startedAt: cleanName(startedAt, 100),
		endedAt: cleanName(endedAt, 100),
		userPrompts: [],
		userPromptCount: 0,
		toolCalls: [],
		assistantText: [],
		errors: [],
		failedCommands: [],
		// Null prototype: a stopReason key named '__proto__' must be an own
		// property, not swallowed by the Object.prototype setter.
		stopReasons: Object.create(null) as Record<string, number>,
		models: [],
		compactions: 0,
		usage: { input: 0, output: 0, cost: 0 },
		messageCount: 0,
	};

	const seenModels = new Set<string>();
	// Dedup Sets are bounded too: a failure-heavy session must not grow them
	// without limit. Beyond 100 distinct failures, new ones are not recorded
	// (the arrays are capped at 20 anyway).
	const seenErrors = new Set<string>();
	const seenCommands = new Set<string>();
	const DEDUP_CAP = 100;
	/** toolCallId → bash command, from assistant toolCalls. */
	const bashCommands = new Map<string, string>();
	/** Raw (unstringified) trace buffers — stringify only the kept calls. */
	const rawToolCalls: Array<{ tool: string; args: unknown }> = [];
	const rawAssistantText: string[] = [];

	for (const raw of entries) {
		if (!raw || typeof raw !== "object") continue;
		const entry = raw as RawEntry;

		// Session header (present in tests; getEntries() excludes it in pi).
		// The parameters are already sanitized at assignment above. This
		// branch re-sanitizes the header values. A control char in the
		// project directory name can then never make the digest fail
		// validation on load.
		if (entry.type === "session") {
			if (typeof entry.cwd === "string" && entry.cwd) digest.cwd = cleanName(entry.cwd, 2000);
			if (typeof entry.id === "string" && entry.id) digest.sessionId = cleanName(entry.id, 200);
			if (typeof entry.timestamp === "string" && entry.timestamp) digest.startedAt = cleanName(entry.timestamp, 100);
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
				if (!seenCommands.has(raw) && seenCommands.size < DEDUP_CAP) {
					seenCommands.add(raw);
					const cmd = truncate(raw, COMMAND_MAX_CHARS);
					const error = truncateTail(extractText(msg.output), ERROR_MAX_CHARS) || "(no output)";
					if (digest.failedCommands.length >= COMMAND_CAP) digest.failedCommands.shift();
					digest.failedCommands.push({ command: cmd, error });
				}
			}
			continue;
		}

		if (msg.role === "user") {
			digest.userPromptCount += 1;
			const text = truncate(extractText(msg.content), PROMPT_MAX_CHARS);
			if (text) {
				// Bound during the loop (keeps the newest). A prompt-heavy
				// session must not build a 100k-element array before the cap.
				if (digest.userPrompts.length >= PROMPT_CAP) digest.userPrompts.shift();
				digest.userPrompts.push(text);
			}
			continue;
		}
		if (msg.role === "assistant") {
			if (typeof msg.stopReason === "string" && msg.stopReason) {
				// Bounded and sanitized. A crafted session must not grow the
				// stopReasons object without limit. A crafted key must not
				// insert control chars into the reflection. cleanName cuts
				// by code points and strips lone surrogates.
				const key = cleanName(msg.stopReason, 100);
				if (key) {
					// Use Object.hasOwn. A key naming an Object.prototype
					// property must not be treated as an existing count.
					if (Object.hasOwn(digest.stopReasons, key)) {
						digest.stopReasons[key] = (digest.stopReasons[key] ?? 0) + 1;
					} else if (Object.keys(digest.stopReasons).length < 20) {
						digest.stopReasons[key] = 1;
					}
				}
			}
			if (typeof msg.model === "string" && msg.model) {
				// cleanName strips control chars — a crafted model string
				// must not carry ESC/U+2028 into the reflection. Dedup on
				// the CLEANED name so raw-vs-cleaned duplicates collapse.
				const model = cleanName(msg.model, 200);
				if (model && !seenModels.has(model) && seenModels.size < 20) {
					seenModels.add(model);
					digest.models.push(model);
				}
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
					// Assistant trace: what the model did. The reflection
					// can then see silent mistakes. Bound during the loop
					// (shift+push keeps the newest) so a 10k-call session
					// does not build a 10k-element array.
					if (b.type === "toolCall" && typeof b.name === "string") {
						if (rawToolCalls.length >= TOOL_CALL_CAP) rawToolCalls.shift();
						// cleanName strips control chars (a prompt-injected
						// model can emit a tool name with ESC/U+2028).
						rawToolCalls.push({ tool: cleanName(b.name, TOOL_NAME_MAX_CHARS), args: b.arguments });
					} else if (b.type === "text" && typeof b.text === "string" && b.text.trim()) {
						if (rawAssistantText.length >= ASSISTANT_TEXT_CAP) rawAssistantText.shift();
						rawAssistantText.push(b.text);
					}
				}
			}
			continue;
		}

		if (msg.role === "toolResult") {
			// Real bash failures: the tool throws, so isError is true and
			// the text ends with "Command exited with code N". A command
			// that prints "exit code: 5" exits 0 with isError false. It is
			// not a failure.
			if (msg.toolName === "bash") {
				if (msg.isError === true) {
					const raw = typeof msg.toolCallId === "string" ? bashCommands.get(msg.toolCallId) : undefined;
					const key = raw ?? "(unknown command)";
					if (!seenCommands.has(key) && seenCommands.size < DEDUP_CAP) {
						seenCommands.add(key);
						const cmd = truncate(key, COMMAND_MAX_CHARS);
						const error = truncateTail(extractText(msg.content), ERROR_MAX_CHARS) || "(no output)";
						if (digest.failedCommands.length >= COMMAND_CAP) digest.failedCommands.shift();
						digest.failedCommands.push({ command: cmd, error });
					}
				}
				continue;
			}

			// Other failed tools: isError/toolName on the message object.
			if (msg.isError === true) {
				// cleanName strips control chars and bounds the length — a
				// crafted session file must not enlarge the digest via toolName.
				const tool = cleanName(typeof msg.toolName === "string" ? msg.toolName : "tool", TOOL_NAME_MAX_CHARS);
				const summary = truncate(extractText(msg.content), ERROR_MAX_CHARS) || "(no output)";
				const key = `${tool}:${summary}`;
				if (!seenErrors.has(key) && seenErrors.size < DEDUP_CAP) {
					seenErrors.add(key);
					if (digest.errors.length >= ERROR_CAP) digest.errors.shift();
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
	// Cap failures too — a failure-heavy session must not grow the digest
	// without limit.
	if (digest.errors.length > ERROR_CAP) {
		digest.errors = digest.errors.slice(-ERROR_CAP);
	}
	if (digest.failedCommands.length > COMMAND_CAP) {
		digest.failedCommands = digest.failedCommands.slice(-COMMAND_CAP);
	}
	// Stringify the kept trace calls (the raw buffers are already bounded).
	// The replacer truncates string values. A huge field is then not fully
	// serialized. A circular or too-deep object throws. The args are
	// dropped rather than losing the digest.
	for (const t of rawToolCalls) {
		let args = "";
		if (typeof t.args === "object" && t.args !== null) {
			try {
				args = JSON.stringify(t.args, (_k, v) => (typeof v === "string" ? v.slice(0, 200) : v));
			} catch {
				args = "";
			}
		}
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
	const hasAbnormalStop = Object.keys(digest.stopReasons).some((k) => !Object.hasOwn(BENIGN_STOP_REASONS, k));
	if (hasAbnormalStop) return true;
	if (digest.compactions > 0) return true;
	// A long successful session is worth reflecting on. It must be well
	// above the default threshold. Without a failure signal the model
	// writes platitudes. userPromptCount is uncapped (userPrompts is
	// capped at 12).
	return digest.userPromptCount >= Math.max(minPrompts, 20);
}


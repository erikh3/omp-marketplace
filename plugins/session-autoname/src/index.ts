import type {
	ExtensionAPI,
	ExtensionContext,
	InputEventResult,
	SessionMessageEntry,
} from "@oh-my-pi/pi-coding-agent";
import { completeSimple } from "@oh-my-pi/pi-ai";
import { generateSessionTitle } from "@oh-my-pi/pi-coding-agent/utils/title-generator";

/** Status-bar slot key used while a name is being generated. */
const STATUS_KEY = "session-autoname";

/** Bare `/rename` (no title) with optional trailing whitespace only. */
const BARE_RENAME = /^\/rename\s*$/;

/**
 * Character budget for the transcript fed to the summary model. Generous — the
 * session model has a large context window — but bounded so a very long session
 * cannot balloon the summary request. Overflow is middle-truncated, keeping the
 * opening goal and the latest direction.
 */
const MAX_TRANSCRIPT_CHARS = 24_000;

/**
 * Transcript length above which a summary pass runs before titling. The tiny
 * title model middle-truncates its own input to ~2000 chars, so a transcript at
 * or below this bound already reaches the model whole and needs no summary; a
 * larger one would otherwise lose its middle, which the summary step preserves.
 */
const SUMMARY_TRIGGER_CHARS = 2_000;

/** Output ceiling for the summary pass — a few sentences, not a document. */
const SUMMARY_MAX_TOKENS = 256;

/** System prompt for the whole-transcript summary that precedes titling. */
const SUMMARY_SYSTEM_PROMPT =
	"You summarize a coding-assistant session transcript. In 2-3 plain sentences, " +
	"state the main task or goal the user pursued and what was actually done or " +
	"decided across the WHOLE session, not only its latest messages. No preamble, " +
	"no lists, no markdown. Output only the summary.";

/** Extract concatenated plain text from a message's content (string or blocks). */
function textFromContent(content: unknown): string {
	if (typeof content === "string") return content.trim();
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		if (!block || typeof block !== "object") continue;
		const record = block as { type?: unknown; text?: unknown };
		if (record.type !== "text" || typeof record.text !== "string") continue;
		const text = record.text.trim();
		if (text) parts.push(text);
	}
	return parts.join("\n\n");
}

/** Middle-truncate `text` to `max` chars, keeping 2/3 head and 1/3 tail. */
function boundTranscript(text: string, max: number): string {
	if (text.length <= max) return text;
	const marker = "\n\n[… middle of session omitted …]\n\n";
	// Budget too small to fit the marker: just hard-cut to `max`.
	if (max <= marker.length) return text.slice(0, max);
	const keep = max - marker.length;
	const head = Math.ceil((keep * 2) / 3);
	const tail = keep - head;
	return `${text.slice(0, head)}${marker}${text.slice(text.length - tail)}`;
}

/**
 * Render the full session transcript as `Role: text` turns, bounded to
 * {@link MAX_TRANSCRIPT_CHARS}. Unlike omp's recent-turns title digest, this
 * spans the WHOLE conversation so the generated name reflects the entire
 * session rather than only its last few turns. Only user/assistant message
 * *text* is kept — tool calls, tool results, thinking, images, and
 * system/developer messages are excluded as title noise. Returns `null` when
 * there is no user/assistant text worth naming yet.
 */
function sessionTranscript(ctx: ExtensionContext): string | null {
	const messages = ctx.sessionManager
		.getEntries()
		.filter((entry): entry is SessionMessageEntry => entry.type === "message")
		.map(entry => entry.message);
	const turns: string[] = [];
	for (const message of messages) {
		if (message.role !== "user" && message.role !== "assistant") continue;
		const text = textFromContent(message.content);
		if (!text) continue;
		turns.push(`${message.role === "user" ? "User" : "Assistant"}: ${text}`);
	}
	if (turns.length === 0) return null;
	return boundTranscript(turns.join("\n\n"), MAX_TRANSCRIPT_CHARS);
}

/**
 * Summarize the whole transcript with the current session model (which always
 * has working credentials) into a few sentences. Returns `null` when no model
 * is active or the request fails — the caller then titles the raw transcript.
 */
async function summarizeTranscript(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	transcript: string,
): Promise<string | null> {
	const model = ctx.model;
	if (!model) return null;
	try {
		const sessionId = ctx.sessionManager.getSessionId?.();
		const response = await completeSimple(
			model,
			{
				systemPrompt: [SUMMARY_SYSTEM_PROMPT],
				messages: [{ role: "user", content: transcript, timestamp: Date.now() }],
			},
			{
				apiKey: ctx.modelRegistry.resolver(model, sessionId),
				maxTokens: SUMMARY_MAX_TOKENS,
				disableReasoning: true,
				temperature: 0,
			},
		);
		if (response.stopReason === "error") return null;
		return textFromContent(response.content) || null;
	} catch (error) {
		pi.logger.warn("session-autoname: summary generation failed", {
			error: error instanceof Error ? error.message : String(error),
		});
		return null;
	}
}

/**
 * Generate a short session name from the transcript. The whole transcript is
 * summarized first (when it is long enough to otherwise be truncated) and the
 * summary — or the raw transcript for short sessions — is handed to the
 * configured smol title model. Returns `null` when there is too little signal /
 * the model declines.
 */
async function generateNameFromLogs(pi: ExtensionAPI, ctx: ExtensionContext): Promise<string | null> {
	const transcript = sessionTranscript(ctx);
	if (!transcript) return null;
	let digest = transcript;
	if (transcript.length > SUMMARY_TRIGGER_CHARS) {
		const summary = await summarizeTranscript(pi, ctx, transcript);
		if (summary) digest = summary;
	}
	// Same engine as omp auto-titling: honors `providers.tinyModel` (local tiny
	// worker or the online `@smol` role). No online fallback is forced here.
	// Use pi.pi.settings (the harness's initialized instance) to avoid the
	// module-isolation issue: if the plugin has its own node_modules, a direct
	// import resolves to a separate module copy whose globalInstance is null,
	// causing the settings proxy to throw "Settings not initialized."
	return generateSessionTitle(
		digest,
		ctx.modelRegistry,
		pi.pi.settings,
		ctx.sessionManager.getSessionId?.(),
		ctx.model,
	);
}

/**
 * Apply a session name. A non-empty `rawArgs` is used verbatim; an empty one
 * triggers smol-model generation from the session logs.
 */
async function applyName(pi: ExtensionAPI, ctx: ExtensionContext, rawArgs: string): Promise<void> {
	const explicit = rawArgs.trim();
	if (explicit) {
		await pi.setSessionName(explicit);
		ctx.ui.notify(`Session renamed to "${explicit}".`, "info");
		return;
	}

	ctx.ui.setStatus(STATUS_KEY, "Naming session…");
	try {
		const generated = await generateNameFromLogs(pi, ctx);
		if (!generated) {
			ctx.ui.notify("Not enough conversation yet to name this session.", "warning");
			return;
		}
		await pi.setSessionName(generated);
		ctx.ui.notify(`Session named "${generated}".`, "info");
	} catch (error) {
		pi.logger.warn("session-autoname: generation failed", {
			error: error instanceof Error ? error.message : String(error),
		});
		ctx.ui.notify("Could not generate a session name.", "error");
	} finally {
		ctx.ui.setStatus(STATUS_KEY, undefined);
	}
}

/**
 * session-autoname: `/name [title]` and bare `/rename`.
 *
 * - `/name` or `/rename` with **no** argument: spawn the smol title model to
 *   name the session from its logs.
 * - `/name <title>`: set the name directly.
 * - `/rename <title>`: untouched — handled by the built-in command.
 *
 * `/rename` is a reserved built-in and cannot be re-registered, so its no-arg
 * form is intercepted on the `input` event (which fires before slash dispatch)
 * and only when the argument list is empty; anything else falls through.
 */
export default function sessionAutoname(pi: ExtensionAPI): void {
	// `/name` is not a built-in, so register it for autocomplete/help and for
	// non-interactive (ACP/RPC) modes where the `input` event does not fire.
	pi.registerCommand("name", {
		description: "Name the session (auto-generates from logs when no title is given)",
		handler: (args, ctx) => applyName(pi, ctx, args),
	});

	// Intercept bare `/rename` before the built-in usage error runs. Everything
	// else (including `/rename <title>` and `/name …`) passes through untouched.
	pi.on("input", async (event, ctx): Promise<InputEventResult | void> => {
		if (!BARE_RENAME.test(event.text.trim())) return;
		await applyName(pi, ctx, "");
		return { handled: true };
	});
}

import type {
	ExtensionAPI,
	ExtensionContext,
	InputEventResult,
	SessionMessageEntry,
} from "@oh-my-pi/pi-coding-agent";
import { completeSimple } from "@oh-my-pi/pi-ai";
import { generateSessionTitle } from "@oh-my-pi/pi-coding-agent/utils/title-generator";

import searchableTitlePrompt from "./searchable-title.md" with { type: "text" };

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

/** Output ceiling for direct long-session title generation. */
const SESSION_TITLE_MAX_TOKENS = 64;

/** System prompt for producing a specific, searchable whole-session title. */
const SESSION_TITLE_SYSTEM_PROMPT =
	"Write one specific, searchable title for this coding-assistant session. Use 5-10 words and " +
	"at most 80 characters. The title must include at least two exact distinguishing terms from the " +
	"transcript, such as component, repository, plugin, command, service, library, ticket, product, " +
	"version, environment, or error names. State the action or outcome. If the session covered several " +
	"related steps, capture the story connecting them. Never include a URL, hostname, link, filesystem " +
	"path, repository path, or opaque PR number. Describe the work in plain words using surrounding " +
	"context, not a location stripped down to a repository and number. Name the repository, component, " +
	"plugin, or behavior only when it helps explain the work. Never replace concrete details with generic " +
	"phrases such as version upgrade, bug fix, code update, configuration change, plugin integration, " +
	"or investigation. No preamble, quotes, punctuation, markdown, or title tags. Output only the title.";

const MAX_TITLE_ATTEMPTS = 2;

const GENERIC_TITLE = /^(?:version upgrade|bug fix|code update|configuration change|plugin integration|investigation)$/i;
const TITLE_WORD = /[\p{L}\p{N}]+/gu;
const MARKDOWN_LINK = /\[([^\]]+)\]\([^)]+\)/g;
const LOCATION_TOKEN = /(?:https?:\/\/|www\.)\S+|\S*\/\S+|(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,}\S*/g;

function withoutLocations(value: string): string {
	return value
		.replace(MARKDOWN_LINK, "$1")
		.replace(LOCATION_TOKEN, " ")
		.replace(/\s{2,}/g, " ")
		.trim();
}

function searchableTitle(value: string | null): string | null {
	const rawTitle = value?.split(/\r?\n/, 1)[0]?.trim().replace(/^<title>|<\/title>$/gi, "").replace(/^["']|["']$/g, "");
	const title = rawTitle ? withoutLocations(rawTitle) : undefined;
	const words = title?.match(TITLE_WORD)?.length ?? 0;
	return title && title.length <= 80 && words >= 5 && words <= 12 && !GENERIC_TITLE.test(title) ? title : null;
}

function searchableIdentifiers(transcript: string): string[] {
	const matches = transcript.match(/[A-Za-z0-9@][A-Za-z0-9@._/-]{1,79}/g) ?? [];
	const identifiers: string[] = [];
	const seen = new Set<string>();
	for (const match of matches) {
		const candidates = match.includes("/") ? match.split("/") : [match];
		for (const candidate of candidates) {
			const clean = candidate.replace(/^@/, "");
			if (!clean || /^(?:https?|www|github\.com|pull|blob|tree)$/i.test(clean)) continue;
			if (!clean.includes("-") && !/^\d+(?:\.\d+)+$/.test(clean)) continue;
			const normalized = clean.toLowerCase();
			if (seen.has(normalized)) continue;
			seen.add(normalized);
			identifiers.push(clean);
			if (identifiers.length === 12) return identifiers;
		}
	}
	return identifiers;
}

function containsIdentifier(title: string, identifiers: readonly string[]): boolean {
	const normalizedTitle = title.toLowerCase();
	return identifiers.length === 0 || identifiers.some(identifier => normalizedTitle.includes(identifier.toLowerCase()));
}

function groundedTitle(value: string | null, identifiers: readonly string[]): string | null {
	const title = searchableTitle(value);
	if (title && containsIdentifier(title, identifiers)) return title;
	const rawBase = value?.split(/\r?\n/, 1)[0]?.trim().replace(/^<title>|<\/title>$/gi, "").replace(/^["']|["']$/g, "");
	const base = rawBase ? withoutLocations(rawBase) : undefined;
	if (!base || identifiers.length === 0) return null;
	let candidate = base;
	for (const identifier of identifiers) {
		if (candidate.toLowerCase().includes(identifier.toLowerCase())) continue;
		const expanded = `${candidate} ${identifier}`;
		if (expanded.length > 80 || (expanded.match(TITLE_WORD)?.length ?? 0) > 12) break;
		candidate = expanded;
		if ((candidate.match(TITLE_WORD)?.length ?? 0) >= 5) return candidate;
	}
	return null;
}

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
 * Render the current branch transcript as `Role: text` turns, bounded to
 * {@link MAX_TRANSCRIPT_CHARS}. Unlike omp's recent-turns title digest, this
 * spans the whole active branch so the generated name reflects the complete
 * path to the current leaf without including abandoned branches. Only
 * user/assistant message text is kept. Tool calls, tool results, thinking,
 * images, and system/developer messages are excluded as title noise. Returns
 * `null` when there is no user/assistant text worth naming yet.
 */
function sessionTranscript(ctx: ExtensionContext): string | null {
	const messages = ctx.sessionManager
		.getBranch()
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

/** Generate a searchable title directly with the active session model. */
async function generateLongSessionTitle(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	transcript: string,
): Promise<string | null> {
	const model = ctx.model;
	if (!model) return null;
	const identifiers = searchableIdentifiers(transcript);
	try {
		const sessionId = ctx.sessionManager.getSessionId?.();
		let rejectedTitle: string | undefined;
		for (let attempt = 0; attempt < MAX_TITLE_ATTEMPTS; attempt++) {
			const correction = rejectedTitle
				? `\n\nThe previous title was too vague or invalid: "${rejectedTitle}". Replace it with concrete names from the transcript.`
				: "";
			const identifierHint =
				identifiers.length > 0
					? `\n\nExact searchable terms found in the transcript: ${identifiers.join(", ")}. Use the relevant terms verbatim.`
					: "";
			const response = await completeSimple(
				model,
				{
					systemPrompt: [`${SESSION_TITLE_SYSTEM_PROMPT}${identifierHint}${correction}`],
					messages: [{ role: "user", content: transcript, timestamp: Date.now() }],
				},
				{
					apiKey: ctx.modelRegistry.resolver(model, sessionId),
					maxTokens: SESSION_TITLE_MAX_TOKENS,
					disableReasoning: true,
					temperature: 0,
				},
			);
			if (response.stopReason === "error") return null;
			const rawTitle = textFromContent(response.content);
			const title = searchableTitle(rawTitle);
			if (title && containsIdentifier(title, identifiers)) return title;
			pi.logger.debug("session-autoname: rejected title candidate", { title: rawTitle, identifiers });
			rejectedTitle = rawTitle;
		}
		return groundedTitle(rejectedTitle ?? null, identifiers);
	} catch (error) {
		pi.logger.warn("session-autoname: long-session title generation failed", {
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
	if (transcript.length > SUMMARY_TRIGGER_CHARS) {
		const title = await generateLongSessionTitle(pi, ctx, transcript);
		if (title) return title;
	}
	// Same engine as omp auto-titling: honors `providers.tinyModel` (local tiny
	// worker or the online `@smol` role). No online fallback is forced here.
	// Use pi.pi.settings (the harness's initialized instance) to avoid the
	// module-isolation issue: if the plugin has its own node_modules, a direct
	// import resolves to a separate module copy whose globalInstance is null,
	// causing the settings proxy to throw "Settings not initialized."
	const generated = await generateSessionTitle(
		transcript,
		ctx.modelRegistry,
		pi.pi.settings,
		ctx.sessionManager.getSessionId?.(),
		ctx.model,
		undefined,
		searchableTitlePrompt,
	);
	return groundedTitle(generated, searchableIdentifiers(transcript));
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

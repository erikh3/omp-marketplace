import type {
	ExtensionAPI,
	ExtensionContext,
	InputEventResult,
	SessionMessageEntry,
} from "@oh-my-pi/pi-coding-agent";
import { buildReplanTitleContext } from "@oh-my-pi/pi-coding-agent";
import { generateSessionTitle } from "@oh-my-pi/pi-coding-agent/utils/title-generator";

/** Status-bar slot key used while a name is being generated. */
const STATUS_KEY = "session-autoname";

/** Bare `/rename` (no title) with optional trailing whitespace only. */
const BARE_RENAME = /^\/rename\s*$/;

/**
 * Build the session-log digest fed to the title model.
 *
 * Reuses omp's own replan-title context builder over the live transcript, so
 * the generated name is derived from the same recent user/assistant turns omp
 * uses when it refreshes a title after replanning. Returns `null` when there is
 * nothing worth naming yet (empty session).
 */
function sessionLogDigest(ctx: ExtensionContext): string | null {
	const messages = ctx.sessionManager
		.getEntries()
		.filter((entry): entry is SessionMessageEntry => entry.type === "message")
		.map(entry => entry.message);
	if (messages.length === 0) return null;
	const digest = buildReplanTitleContext(messages);
	return digest.trim() ? digest : null;
}

/**
 * Generate a short session name from the transcript using the configured smol
 * title model, or `null` when there is too little signal / the model declines.
 */
async function generateNameFromLogs(pi: ExtensionAPI, ctx: ExtensionContext): Promise<string | null> {
	const digest = sessionLogDigest(ctx);
	if (!digest) return null;
	// Same engine as omp auto-titling: honors `providers.tinyModel` (local tiny
	// worker or the online `@smol` role). No online fallback is forced here.
	// Use pi.pi.settings (the harness's initialized instance) to avoid the
	// module-isolation issue: if the plugin has its own node_modules, a direct
	// import resolves to a separate module copy whose globalInstance is null,
	// causing the settings proxy to throw "Settings not initialized."
	return generateSessionTitle(digest, ctx.modelRegistry, pi.pi.settings, undefined, ctx.model ?? undefined);
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

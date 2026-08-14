/**
 * Ex command dispatch — bridges a parsed ex line to host side-effects.
 *
 * Responsibilities:
 *  - Quit-family check (with dirty-prompt guard via `host.getText`).
 *  - Shell passthrough (`!cmd`).
 *  - Reserved-name precedence (reserved > registered command).
 *  - Known slash-command dispatch via `host.runExCommand`.
 *  - Unknown-command notification fallback.
 *
 * What stays in the EDITOR (not here):
 *  - Accumulating characters into the ex buffer (`#handleEx`).
 *  - The async setText / cursor restore after `runExCommand` resolves
 *    (pure omp-side buffer bookkeeping, not vim logic).
 *  - The `#dispatchQuit` seam that routes `/quit` through `runExCommand`.
 */

import type { ExParse } from "./parser.js";
import { QUIT_NAMES, RESERVED_NAMES } from "./parser.js";

/**
 * The host surface `dispatchEx` is allowed to touch. Exactly the callbacks
 * the editor exposes for ex command execution.
 *
 * `runExCommand` is pre-wrapped by the editor to include the synchronous and
 * asynchronous buffer-restore dance — `commands.ts` just calls it.
 */
export interface ExHost {
	/** Pre-wrapped dispatcher that also handles the draft restore. */
	runExCommand?: (line: string) => void;
	/** Show a warning / info message to the user. */
	notifyUser: (message: string) => void;
	/** All slash commands registered with the host at dispatch time. */
	getCommandNames: () => ReadonlySet<string>;
	/** Current draft text — needed for the dirty-prompt quit guard. */
	getText: () => string;
	/** Quit the session (clears draft, routes `/quit` through the host). */
	dispatchQuit: () => void;
}

/**
 * Dispatch a parsed ex line against the host.
 *
 * Resolution order (mirrors the original `#submitEx`):
 *  1. Quit family (with optional `!` force flag + dirty-prompt guard).
 *  2. Shell passthrough (`!cmd`).
 *  3. Reserved-name block (takes precedence over registered commands).
 *  4. Known slash command → `runExCommand`.
 *  5. Unknown → `notifyUser`.
 */
export function dispatchEx(parse: ExParse, host: ExHost): void {
	if (parse.kind === "empty") return;

	const { name, args, raw } = parse as { kind: "command"; name: string; args: string; raw: string };

	// 1. Quit family: :q / :qa / :quit / :qall / :quitall (with optional !).
	const force = name.endsWith("!");
	const quitName = force ? name.slice(0, -1) : name;
	if (args === "" && Object.hasOwn(QUIT_NAMES, quitName)) {
		if (!force && host.getText().trim().length > 0) {
			host.notifyUser(`Prompt is not empty; use :${name}! to quit anyway`);
			return;
		}
		host.dispatchQuit();
		return;
	}

	// 2. Shell passthrough: name starts with "!" (already captured as full name).
	if (name.startsWith("!")) {
		const shell = name.replace(/^!+/, "").trim();
		if (shell) {
			host.runExCommand?.(name);
		} else {
			host.notifyUser(`Unsupported ex command: :${name}`);
		}
		return;
	}

	// 3. Reserved names take precedence over registered commands.
	const bareName = name.endsWith("!") ? name.slice(0, -1) : name;
	if (Object.hasOwn(RESERVED_NAMES, bareName)) {
		host.notifyUser(`Reserved ex command: :${name}`);
		return;
	}

	// 4. Known slash command registered with the host.
	if (host.getCommandNames().has(name)) {
		host.runExCommand?.(args ? `/${name} ${args}` : `/${name}`);
		return;
	}

	// 5. Unknown command.
	host.notifyUser(`Unsupported ex command: :${raw}`);
}

/**
 * Mode-change side effects wired by the extension.
 *
 * On every actual mode transition pi-vim:
 *   1. emits `pi-vim:mode-change` on `pi.events` with `{ mode, previousMode }`
 *      so other extensions can react (e.g. status lines);
 *   2. runs the configured `modeChange` shell hook — `insert` on entering
 *      INSERT, `normal` on entering any non-INSERT editing mode (NORMAL,
 *      VISUAL, V-LINE). Hooks run via `pi.exec` through the user's shell,
 *      fire-and-forget; a missing command runs nothing.
 *
 * The handler is a pure factory over an injected `ExtensionAPI`, so it is unit
 * tested with a fake pi (no real event bus or subprocess).
 */

import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import type { VimMode } from "../modal-editor.js";
import type { PiVimConfig } from "./config.js";

/** Event channel other extensions can subscribe to for pi-vim mode changes. */
export const MODE_CHANGE_EVENT = "pi-vim:mode-change";

/**
 * Build the mode-change handler. The returned function is called on every
 * actual transition with the new and previous modes.
 */
export function makeModeChangeHandler(
	pi: ExtensionAPI,
	config: PiVimConfig,
): (mode: VimMode, previousMode: VimMode) => void {
	const shell = process.env.SHELL || "/bin/sh";
	return (mode: VimMode, previousMode: VimMode): void => {
		pi.events.emit(MODE_CHANGE_EVENT, { mode, previousMode });
		const command = mode === "insert" ? config.modeChange.insert : config.modeChange.normal;
		if (command === undefined || command === "") return;
		void pi.exec(shell, ["-c", command]).catch(() => {});
	};
}

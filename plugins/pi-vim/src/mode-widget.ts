import type { Theme } from "@oh-my-pi/pi-coding-agent";
import type { Component } from "@oh-my-pi/pi-tui";
import { visibleWidth } from "@oh-my-pi/pi-tui";
import type { VimMode } from "./modal-editor.js";

/** Footer label per mode; VISUAL-LINE shows as vim's short `V-LINE`. */
const LABELS: Record<VimMode, string> = {
	normal: "NORMAL",
	insert: "INSERT",
	visual: "VISUAL",
	"visual-line": "V-LINE",
};

/**
 * A one-line widget mounted below the editor that shows the active Vim mode,
 * right-aligned like Pi's TUI (and most editors). The label is pushed to the
 * right edge by left-padding with spaces to the render width; the styled label
 * is measured with {@link visibleWidth} so ANSI escapes do not count toward the
 * padding.
 */
export class ModeWidget implements Component {
	#mode: VimMode;
	readonly #theme: Theme;
	#cached: readonly string[] | undefined;
	#cachedWidth = -1;
	/** The live ex command buffer (e.g. `":q"`), or `null` when not in ex mode. */
	#exCommand: string | null = null;

	constructor(mode: VimMode, theme: Theme) {
		this.#mode = mode;
		this.#theme = theme;
	}

	setMode(mode: VimMode): void {
		if (this.#mode === mode) return;
		this.#mode = mode;
		this.#cached = undefined;
	}

	/**
	 * Updates the ex command buffer and invalidates the render cache when the
	 * value changes. Pass `null` to exit ex display and revert to mode label.
	 */
	setExCommand(command: string | null): void {
		if (this.#exCommand === command) return;
		this.#exCommand = command;
		this.#cached = undefined;
	}

	render(width: number): readonly string[] {
		if (this.#cached && this.#cachedWidth === width) return this.#cached;
		const label =
			this.#exCommand !== null
				? ` EX ${this.#exCommand}_ `
				: ` ${LABELS[this.#mode]} `;
		// EX and NORMAL/VISUAL modes use an accent inverse block (`\x1b[7m` is
		// reverse-video); INSERT stays muted so it reads as the resting state.
		// Ex mode takes precedence: even if the underlying vim mode is insert,
		// the ex command line always renders with accent reverse-video.
		const styled =
			this.#exCommand === null && this.#mode === "insert"
				? this.#theme.fg("muted", label)
				: this.#theme.fg("accent", `\x1b[7m${label}\x1b[27m`);
		const pad = Math.max(0, width - visibleWidth(styled));
		this.#cached = [" ".repeat(pad) + styled];
		this.#cachedWidth = width;
		return this.#cached;
	}

	invalidate(): void {
		this.#cached = undefined;
	}
}

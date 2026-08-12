import type { Theme, ThemeColor } from "@oh-my-pi/pi-coding-agent";
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
 * Theme color token per mode, matching upstream `lajarre/pi-vim`'s palette:
 * INSERT is the muted border tone, NORMAL the accent border, both VISUAL modes
 * the custom-message label color, and EX the warning color. Each is applied as
 * reverse-video (see {@link ModeWidget.render}), so the token becomes the
 * block's fill and the text shows in the theme background.
 */
const COLORS: Record<VimMode, ThemeColor> = {
	normal: "borderAccent",
	insert: "borderMuted",
	visual: "customMessageLabel",
	"visual-line": "customMessageLabel",
};

/** EX (execute) command line uses the warning color, like upstream. */
const EX_COLOR: ThemeColor = "warning";

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
		// Every mode (and the EX line) renders as a filled reverse-video block:
		// `\x1b[7m` swaps fg/bg, so the mode's color token becomes the block fill
		// and the label shows in the theme background. EX takes precedence over
		// the underlying mode and uses the warning color.
		const label =
			this.#exCommand !== null
				? ` EX ${this.#exCommand}_ `
				: ` ${LABELS[this.#mode]} `;
		const color = this.#exCommand !== null ? EX_COLOR : COLORS[this.#mode];
		const styled = this.#theme.fg(color, `\x1b[7m${label}\x1b[27m`);
		const pad = Math.max(0, width - visibleWidth(styled));
		this.#cached = [" ".repeat(pad) + styled];
		this.#cachedWidth = width;
		return this.#cached;
	}

	invalidate(): void {
		this.#cached = undefined;
	}
}

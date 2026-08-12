import type { Theme } from "@oh-my-pi/pi-coding-agent";
import type { Component } from "@oh-my-pi/pi-tui";
import { visibleWidth } from "@oh-my-pi/pi-tui";
import type { VimMode } from "./modal-editor.js";

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

	constructor(mode: VimMode, theme: Theme) {
		this.#mode = mode;
		this.#theme = theme;
	}

	setMode(mode: VimMode): void {
		if (this.#mode === mode) return;
		this.#mode = mode;
		this.#cached = undefined;
	}

	render(width: number): readonly string[] {
		if (this.#cached && this.#cachedWidth === width) return this.#cached;
		const label = this.#mode === "normal" ? " NORMAL " : " INSERT ";
		// NORMAL uses an accent inverse block; INSERT stays muted so it reads as
		// the resting state. `\x1b[7m` is reverse-video for the block look.
		const styled =
			this.#mode === "normal"
				? this.#theme.fg("accent", `\x1b[7m${label}\x1b[27m`)
				: this.#theme.fg("muted", label);
		const pad = Math.max(0, width - visibleWidth(styled));
		this.#cached = [" ".repeat(pad) + styled];
		this.#cachedWidth = width;
		return this.#cached;
	}

	invalidate(): void {
		this.#cached = undefined;
	}
}

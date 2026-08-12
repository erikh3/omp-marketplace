/**
 * Host-seam interfaces for the vim engine.
 *
 * `BufferView` is the read-only surface the pure engine reads through.
 * `HostEffects` is the write/effect surface the engine drives.
 *
 * Both are defined here so the engine never imports the concrete editor,
 * keeping the dependency arrow pointing inward (engine → host seam ← shell).
 *
 * NOTE: `VimMode` lives here (not in `modal-editor.ts`) so that `adapter.ts`
 * depends on nothing in the shell, avoiding circular imports. `modal-editor.ts`
 * re-exports it for existing consumers.
 */

/** The four modal-editing modes. */
export type VimMode = "normal" | "insert" | "visual" | "visual-line";

/** A cursor position in grapheme-column / logical-line coordinates. */
export interface Pos {
	line: number;
	col: number;
}

/**
 * A half-open range of UTF-16 absolute offsets into the full buffer text
 * (lines joined by `\n`). `start` is inclusive; `end` is exclusive.
 */
export interface AbsRange {
	start: number;
	end: number;
}

/**
 * Read-only view of the prompt buffer.
 *
 * The pure vim engine (motions, text-objects, visual geometry) reads ONLY
 * through this surface — nothing in the engine writes to the buffer directly.
 */
export interface BufferView {
	/** All logical lines of the buffer (no trailing newline on each). */
	getLines(): readonly string[];
	/** Full buffer text with logical lines joined by `"\n"`. */
	getText(): string;
	/** Current cursor position in `{ line, col }` grapheme-column coordinates. */
	getCursor(): Pos;
}

/**
 * Effect surface the vim engine drives.
 *
 * Extends `BufferView` so an implementor need only satisfy one interface.
 * The engine never calls these directly; the effect applier (`applyIntents`,
 * arriving in Task 7) calls them in strict intent-emission order.
 *
 * Every method here is a thin facade over an existing concrete operation in
 * `ModalVimEditor`; the facade exists now so the seam is proven by the
 * TypeScript compiler before the evaluator is wired in.
 */
export interface HostEffects extends BufferView {
	/** Move the cursor to `to` via keystroke replay (no direct cursor setter). */
	moveCursor(to: Pos): void;
	/**
	 * Replace the UTF-16 half-open range `[range.start, range.end)` with `text`.
	 * Pure insert: empty range. Pure delete: empty text. Replace: both.
	 */
	replaceRange(range: AbsRange, text: string): void;
	/** Forward `data` directly to the base editor (INSERT passthrough). */
	forward(data: string): void;
	/** Set the active mode and fire `onModeChange` if it changed. */
	signalMode(mode: VimMode): void;
	/** Update the ex command buffer and notify the host. */
	signalEx(buffer: string | null): void;
	/** Run `line` through the host's ex-command pipeline (with buffer restore). */
	runEx(line: string): void | Promise<void>;
	/** Emit a warning notification. */
	notify(message: string): void;
	/** Return the current set of known command names (for `:` tab-complete). */
	getCommandNames(): ReadonlySet<string>;
	/** Undo the last committed change(s). Cancels any open pending change. */
	undo(count: number): void;
	/** Redo the last undone change(s). Cancels any open pending change. */
	redo(count: number): void;
}

// ---------------------------------------------------------------------------
// Effect applier
// ---------------------------------------------------------------------------

import type { EditIntent } from "../engine/intent.js";

/**
 * Execute `intents` in **strict emission order** against `host`.
 *
 * This is the ONE place that calls `HostEffects` methods for buffer mutation /
 * cursor movement / mode signalling. `runEx` may return a `Promise`; the async
 * buffer-restore stays host-side and is outside the synchronous undo bracket.
 */
export function applyIntents(host: HostEffects, intents: EditIntent[]): void {
	for (const intent of intents) {
		switch (intent.kind) {
			case "moveCursor":
				host.moveCursor(intent.to);
				break;
			case "replaceRange":
				host.replaceRange(intent.range, intent.text);
				break;
			case "setMode":
				host.signalMode(intent.mode);
				break;
			case "setExBuffer":
				host.signalEx(intent.value);
				break;
			case "runEx":
				// May return a Promise; the async restore is host-side, not in this bracket.
				void host.runEx(intent.line);
				break;
			case "notify":
				host.notify(intent.message);
				break;
			case "forward":
				host.forward(intent.data);
				break;
		}
	}
}

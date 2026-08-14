/**
 * Visual-mode selection decoration for the terminal editor.
 *
 * Computes per-line selection spans from the current vim state and provides
 * helpers for injecting ANSI background highlighting into rendered text
 * segments during an editor render pass.
 *
 * The typical call flow is:
 *  1. `render()` override in ModalVimEditor calls `computeSelectionSpans(ctx)`
 *     to build a line-indexed span map.
 *  2. The `decorateText` hook calls `advanceScan(…)` to locate each segment's
 *     position in the buffer, then inspects the span and applies color.
 */

import { charwiseRange, linewiseRange } from "./visual-controller.js";
import type { Ctx } from "./state.js";

// ---------------------------------------------------------------------------
// Span model
// ---------------------------------------------------------------------------

/** Half-open column range [startCol, endCol) within a single logical line. */
export interface LineSpan {
	startCol: number;
	endCol: number;
}

/**
 * Build a per-line selection map from the current charwise or linewise
 * selection. Returns `null` when not in visual mode or the selection is empty.
 *
 * The returned map keys are logical line indices (0-based); values are
 * half-open column ranges that should be highlighted.
 */
export function computeSelectionSpans(ctx: Ctx): Map<number, LineSpan> | null {
	const mode = ctx.state.mode;
	if (mode !== "visual" && mode !== "visual-line") return null;

	const lines = ctx.host.getLines() as string[];
	const spans = new Map<number, LineSpan>();

	if (mode === "visual") {
		const { startAbs, endAbs } = charwiseRange(ctx);
		if (startAbs >= endAbs) return null;

		// Convert absolute buffer range to per-line half-open column spans.
		let offset = 0;
		for (let i = 0; i < lines.length; i++) {
			const lineLen = (lines[i] ?? "").length;
			const lineStart = offset;
			const lineEnd = offset + lineLen;
			if (startAbs < lineEnd && endAbs > lineStart) {
				spans.set(i, {
					startCol: Math.max(lineStart, startAbs) - lineStart,
					endCol: Math.min(lineEnd, endAbs) - lineStart,
				});
			}
			offset = lineEnd + 1; // +1 for the implicit '\n' joining lines
		}
	} else {
		// visual-line: whole lines in [startLine, endLine] are selected.
		const { startLine, endLine } = linewiseRange(ctx);
		for (let i = startLine; i <= endLine; i++) {
			const lineLen = (lines[i] ?? "").length;
			if (lineLen > 0) {
				spans.set(i, { startCol: 0, endCol: lineLen });
			}
		}
	}

	return spans.size > 0 ? spans : null;
}

// ---------------------------------------------------------------------------
// Scan state — tracks the buffer position of the current decorateText segment
// ---------------------------------------------------------------------------

/** Mutable scan cursor advanced by `advanceScan` across a single render pass. */
export interface ScanCursor {
	lineIndex: number;
	colOffset: number;
}

/** Construct a fresh scan cursor for the start of a render pass. */
export function makeScanCursor(): ScanCursor {
	return { lineIndex: 0, colOffset: 0 };
}

/**
 * Advance `cursor` past `text` and return the `{lineIndex, startCol}` at
 * which `text` begins in `lines`.
 *
 * The Editor's `decorateText` callback receives segments in source order
 * (top line first, left to right), so a simple forward scan is sufficient.
 * `indexOf(text, cursor.colOffset)` handles word-wrapped chunks where the
 * wrapper skips inter-chunk whitespace (so the chunk start index may be
 * slightly ahead of the tracked offset).
 *
 * Empty lines are skipped silently — the Editor never fires `decorateText`
 * for empty layout lines, so the cursor must jump over them manually.
 */
export function advanceScan(
	cursor: ScanCursor,
	text: string,
	lines: readonly string[],
): { lineIndex: number; startCol: number } {
	if (text.length === 0) {
		return { lineIndex: cursor.lineIndex, startCol: cursor.colOffset };
	}

	// Skip empty lines — decorateText is never called for empty layout lines.
	while (
		cursor.lineIndex < lines.length &&
		(lines[cursor.lineIndex] ?? "").length === 0
	) {
		cursor.lineIndex++;
		cursor.colOffset = 0;
	}

	const lineIndex = cursor.lineIndex;
	const line = lines[lineIndex] ?? "";

	// Locate `text` in the current logical line starting from cursor.colOffset.
	// indexOf handles the wrapped-chunk case where startIndex > previous endIndex
	// (whitespace was skipped between chunks).
	const idx = line.indexOf(text, cursor.colOffset);
	const startCol = idx !== -1 ? idx : cursor.colOffset;

	cursor.colOffset = startCol + text.length;

	// When the scan has consumed the full logical line, step to the next one.
	if (cursor.colOffset >= line.length) {
		cursor.lineIndex++;
		cursor.colOffset = 0;
	}

	return { lineIndex, startCol };
}

// ---------------------------------------------------------------------------
// Color
// ---------------------------------------------------------------------------

/** ANSI escape that resets background to default (does not touch foreground). */
const BG_RESET = "\x1b[49m";

/** Lazily resolved background escape for the visual selection. */
let _selBg: string | undefined;

/**
 * ANSI background escape for the visual selection highlight.
 *
 * Uses hsl(210, 60%, 38%) — a medium steel-blue that is clearly visible on
 * both dark and light terminal backgrounds and contrasts with the cursor's
 * reverse-video highlight. Compiled to truecolor on capable terminals.
 *
 * `Bun.color` is called once and memoized; the result is the raw ANSI
 * foreground escape (e.g. `\x1b[38;2;…m`) converted to a background escape
 * by swapping the `38;` introducer for `48;`.  Falls back to ANSI code 44
 * (built-in blue) when `Bun.color` is unavailable.
 */
function selectionBg(): string {
	if (_selBg !== undefined) return _selBg;
	const fg = Bun.color("hsl(210, 60%, 38%)", "ansi-16m");
	_selBg = fg ? fg.replace("\x1b[38;", "\x1b[48;") : "\x1b[44m";
	return _selBg;
}

/**
 * Returns the ANSI background escape and matching reset for visual selection.
 * Used by the `decorateText` hook in ModalVimEditor when it needs to split
 * text around a selection boundary and decorate each part independently.
 */
export function getSelectionColors(): { bg: string; reset: string } {
	return { bg: selectionBg(), reset: BG_RESET };
}

// ---------------------------------------------------------------------------
// Highlighter
// ---------------------------------------------------------------------------

/**
 * Inject visual selection background color into `text`.
 *
 * `text` is a plain (ANSI-free) segment whose first character sits at
 * `(lineIndex, colStart)` in the logical buffer.  Only the characters that
 * overlap with `span` (if any) receive the background color; the rest of
 * the text is returned as-is so the caller can apply its own decoration to
 * the non-selected portions.
 *
 * Returns `null` when there is no overlap so the caller can avoid the string
 * allocation and apply its own decorator to the full text instead.
 */
export function applyLineSelection(
	text: string,
	lineIndex: number,
	colStart: number,
	spans: Map<number, LineSpan>,
): string | null {
	if (text.length === 0) return null;
	const span = spans.get(lineIndex);
	if (!span) return null;

	const textEnd = colStart + text.length;
	const overlapStart = Math.max(span.startCol, colStart);
	const overlapEnd = Math.min(span.endCol, textEnd);
	if (overlapStart >= overlapEnd) return null;

	const relStart = overlapStart - colStart;
	const relEnd = overlapEnd - colStart;

	const bg = selectionBg();
	return (
		text.slice(0, relStart) +
		bg +
		text.slice(relStart, relEnd) +
		BG_RESET +
		text.slice(relEnd)
	);
}

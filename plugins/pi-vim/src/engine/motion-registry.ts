/**
 * Motion registry — named motions wrapping the vendored pure functions.
 *
 * Each motion is `(ctx, count, arg?) => MotionResult | null`. The evaluator
 * interprets the result per context:
 *   standalone  → move cursor to {targetLine, targetCol}
 *   under op    → build AbsRange from cursor to target, honouring inclusive/linewise
 *   visual      → extend the selection to target
 *
 * Special forms (cw→ce, % inclusive under op) are handled in the evaluator,
 * not here — these functions return raw targets without context-dependent
 * adjustments.
 */

import {
	findWordMotionTarget,
	findFirstNonWhitespaceColumn,
	isBlankLine,
	findParagraphMotionTarget,
	findCharMotionTarget,
	getLineGraphemes,
	type WordMotionClass,
} from "../vim/motions.js";
import { resolveMatchingPairMotionTarget } from "../vim/text-objects.js";
import { lineColToAbs, absToLineCol } from "../host/keystroke-bridge.js";
import type { Ctx } from "./state.js";

/** Result of resolving a motion. */
export interface MotionResult {
	/** Absolute UTF-16 offset of the motion target. */
	targetAbs: number;
	/** Logical line index of the target. */
	targetLine: number;
	/** UTF-16 column within the target line. */
	targetCol: number;
	/**
	 * True when the target grapheme is INCLUDED in the operator range
	 * (e.g. `e`, forward `f`/`t`, `%`). Exclusive (false) means the
	 * operator range stops just BEFORE the target.
	 */
	inclusive: boolean;
	/**
	 * True for line-wise motions (j, k, gg, G). The evaluator treats the
	 * range as whole lines rather than a byte span.
	 */
	linewise: boolean;
}

/** Build a MotionResult from a (line, col) pair in the current buffer. */
export function makeResult(
	lines: readonly string[],
	targetLine: number,
	targetCol: number,
	inclusive: boolean,
	linewise: boolean,
): MotionResult {
	return {
		targetAbs: lineColToAbs(lines, targetLine, targetCol),
		targetLine,
		targetCol,
		inclusive,
		linewise,
	};
}

/** UTF-16 length of the grapheme cluster starting at `abs` in `text`. */
export function graphemeLenAt(text: string, abs: number): number {
	const WINDOW = 16;
	const seg = getLineGraphemes(text.slice(abs, abs + WINDOW))[0];
	return seg ? seg.end - seg.start : 1;
}

/** Column of the first non-whitespace char on a line, or 0 for blank. */
export function firstNonWsCol(lines: readonly string[], lineIdx: number): number {
	const text = lines[lineIdx] ?? "";
	return isBlankLine(text) ? 0 : findFirstNonWhitespaceColumn(text);
}

/**
 * Word motion target (line, col) after `count` steps — the extracted
 * `#wordTargetAbs` logic from `modal-editor.ts`.
 */
export function wordTargetLineCol(
	lines: readonly string[],
	line: number,
	col: number,
	direction: "forward" | "backward",
	target: "start" | "end",
	semanticClass: WordMotionClass,
	count: number,
): { line: number; col: number } {
	const last = lines.length - 1;
	let curLine = line;
	let curCol = col;

	for (let n = 0; n < count; n++) {
		const beforeLine = curLine;
		const beforeCol = curCol;
		const cur = lines[curLine] ?? "";
		const t = findWordMotionTarget(cur, curCol, direction, target, semanticClass);

		if (direction === "forward" && target === "start") {
			if (t > curCol && t < cur.length) {
				curCol = t;
			} else if (curLine < last) {
				curLine++;
				const nl = lines[curLine] ?? "";
				curCol = isBlankLine(nl) ? 0 : findFirstNonWhitespaceColumn(nl);
			} else {
				curCol = cur.length;
			}
		} else if (direction === "forward") {
			// target === "end"
			if (t > curCol) {
				curCol = t;
			} else if (curLine < last) {
				curLine++;
				const nl = lines[curLine] ?? "";
				curCol = findWordMotionTarget(nl, 0, "forward", "end", semanticClass);
			}
		} else {
			// backward
			if (t < curCol) {
				curCol = t;
			} else if (curLine > 0) {
				curLine--;
				const pl = lines[curLine] ?? "";
				curCol = findWordMotionTarget(
					pl,
					pl.length,
					"backward",
					"start",
					semanticClass,
				);
			} else {
				curCol = 0;
			}
		}

		if (curLine === beforeLine && curCol === beforeCol) break;
	}

	return { line: curLine, col: curCol };
}

// ---------------------------------------------------------------------------
// Individual motions
// ---------------------------------------------------------------------------

export function motionH(ctx: Ctx, count: number): MotionResult {
	const { line, col } = ctx.host.getCursor();
	const lines = ctx.host.getLines();
	if (col === 0) return makeResult(lines, line, 0, false, false);
	const text = lines[line] ?? "";
	// Walk back `count` grapheme clusters from the current column.
	let targetCol = col;
	for (let i = 0; i < count && targetCol > 0; i++) {
		// Slice text up to targetCol and find the last grapheme's start.
		const slice = text.slice(0, targetCol);
		const graphemes = getLineGraphemes(slice);
		if (graphemes.length === 0) break;
		targetCol = graphemes[graphemes.length - 1]!.start;
	}
	return makeResult(lines, line, targetCol, false, false);
}

export function motionL(ctx: Ctx, count: number): MotionResult {
	const { line, col } = ctx.host.getCursor();
	// No upper-bound clamp: `l` is allowed past the last char (no hard stop).
	return makeResult(ctx.host.getLines(), line, col + count, false, false);
}

/**
 * `j` — move down `count` lines, preserving column (clamped).
 *
 * Edge case: at the last line, the base editor's ↓ arrow goes to EOL, so we
 * replicate that by setting targetCol = lastLine.length when clamped.
 */
export function motionJ(ctx: Ctx, count: number): MotionResult {
	const lines = ctx.host.getLines();
	const { line, col } = ctx.host.getCursor();
	const lastLine = lines.length - 1;
	const targetLine = Math.min(lastLine, line + count);
	// Clamped (no movement possible): ↓ at last line → EOL
	const targetCol =
		targetLine === line
			? (lines[targetLine] ?? "").length
			: Math.min(col, (lines[targetLine] ?? "").length);
	return makeResult(lines, targetLine, targetCol, false, true);
}

/**
 * `k` — move up `count` lines, preserving column (clamped).
 *
 * Edge case: at the first line, the base editor's ↑ arrow goes to col 0, so
 * we replicate that by setting targetCol = 0 when clamped.
 */
export function motionK(ctx: Ctx, count: number): MotionResult {
	const lines = ctx.host.getLines();
	const { line, col } = ctx.host.getCursor();
	const targetLine = Math.max(0, line - count);
	// Clamped (no movement possible): ↑ at first line → col 0
	const targetCol =
		targetLine === line
			? 0
			: Math.min(col, (lines[targetLine] ?? "").length);
	return makeResult(lines, targetLine, targetCol, false, true);
}

export function motionW(ctx: Ctx, count: number): MotionResult {
	const lines = ctx.host.getLines();
	const { line, col } = ctx.host.getCursor();
	const t = wordTargetLineCol(lines, line, col, "forward", "start", "word", count);
	return makeResult(lines, t.line, t.col, false, false);
}

export function motionBigW(ctx: Ctx, count: number): MotionResult {
	const lines = ctx.host.getLines();
	const { line, col } = ctx.host.getCursor();
	const t = wordTargetLineCol(lines, line, col, "forward", "start", "WORD", count);
	return makeResult(lines, t.line, t.col, false, false);
}

export function motionB(ctx: Ctx, count: number): MotionResult {
	const lines = ctx.host.getLines();
	const { line, col } = ctx.host.getCursor();
	const t = wordTargetLineCol(lines, line, col, "backward", "start", "word", count);
	return makeResult(lines, t.line, t.col, false, false);
}

export function motionBigB(ctx: Ctx, count: number): MotionResult {
	const lines = ctx.host.getLines();
	const { line, col } = ctx.host.getCursor();
	const t = wordTargetLineCol(lines, line, col, "backward", "start", "WORD", count);
	return makeResult(lines, t.line, t.col, false, false);
}

export function motionE(ctx: Ctx, count: number): MotionResult {
	const lines = ctx.host.getLines();
	const { line, col } = ctx.host.getCursor();
	const t = wordTargetLineCol(lines, line, col, "forward", "end", "word", count);
	return makeResult(lines, t.line, t.col, true, false);
}

export function motionBigE(ctx: Ctx, count: number): MotionResult {
	const lines = ctx.host.getLines();
	const { line, col } = ctx.host.getCursor();
	const t = wordTargetLineCol(lines, line, col, "forward", "end", "WORD", count);
	return makeResult(lines, t.line, t.col, true, false);
}

export function motion0(ctx: Ctx, _count: number): MotionResult {
	const { line } = ctx.host.getCursor();
	return makeResult(ctx.host.getLines(), line, 0, false, false);
}

export function motionCaret(ctx: Ctx, _count: number): MotionResult {
	const lines = ctx.host.getLines();
	const { line } = ctx.host.getCursor();
	const col = firstNonWsCol(lines, line);
	return makeResult(lines, line, col, false, false);
}

export function motionDollar(ctx: Ctx, _count: number): MotionResult {
	const lines = ctx.host.getLines();
	const { line } = ctx.host.getCursor();
	const col = (lines[line] ?? "").length;
	return makeResult(lines, line, col, false, false);
}

export function motionLBrace(ctx: Ctx, count: number): MotionResult {
	const lines = ctx.host.getLines();
	const { line } = ctx.host.getCursor();
	const targetLine = findParagraphMotionTarget(lines, line, "backward", count);
	return makeResult(lines, targetLine, 0, false, false);
}

export function motionRBrace(ctx: Ctx, count: number): MotionResult {
	const lines = ctx.host.getLines();
	const { line } = ctx.host.getCursor();
	const targetLine = findParagraphMotionTarget(lines, line, "forward", count);
	return makeResult(lines, targetLine, 0, false, false);
}

/**
 * `%` — jump to the matching bracket/paren/brace.
 *
 * Returns inclusive=false; the evaluator sets inclusive=true when under an
 * operator (vim's `d%` includes the target bracket).
 */
export function motionPercent(ctx: Ctx, _count: number): MotionResult | null {
	const text = ctx.host.getText();
	const lines = ctx.host.getLines();
	const { line, col } = ctx.host.getCursor();
	const curAbs = lineColToAbs(lines, line, col);
	const lineStartAbs = lineColToAbs(lines, line, 0);
	const lineEndAbs = lineStartAbs + (lines[line] ?? "").length;
	const result = resolveMatchingPairMotionTarget(
		text,
		curAbs,
		lineStartAbs,
		lineEndAbs,
	);
	if (result === null) return null;
	const { line: tLine, col: tCol } = absToLineCol(lines, result.targetAbs);
	return {
		targetAbs: result.targetAbs,
		targetLine: tLine,
		targetCol: tCol,
		inclusive: false, // evaluator overrides to true when under operator
		linewise: false,
	};
}

/** `G` — jump to last line (or count-th line if count was given). */
export function motionG(
	ctx: Ctx,
	count: number,
	hasCount: boolean,
): MotionResult {
	const lines = ctx.host.getLines();
	const targetLine = hasCount
		? Math.max(0, Math.min(count - 1, lines.length - 1))
		: lines.length - 1;
	const col = firstNonWsCol(lines, targetLine);
	return makeResult(lines, targetLine, col, false, true);
}

/** `gg` — jump to first line (or count-th line if count was given). */
export function motionGg(
	ctx: Ctx,
	count: number,
	hasCount: boolean,
): MotionResult {
	const lines = ctx.host.getLines();
	const targetLine = hasCount
		? Math.max(0, Math.min(count - 1, lines.length - 1))
		: 0;
	const col = firstNonWsCol(lines, targetLine);
	return makeResult(lines, targetLine, col, false, true);
}

/**
 * Char-find motion (f/F/t/T).
 *
 * Returns inclusive=false; the evaluator sets inclusive=true for forward
 * motions under an operator.
 */
export function charFindMotion(
	ctx: Ctx,
	motion: "f" | "F" | "t" | "T",
	char: string,
	count: number,
	isRepeat: boolean,
): MotionResult | null {
	const lines = ctx.host.getLines();
	const { line, col } = ctx.host.getCursor();
	const text = lines[line] ?? "";
	const targetCol = findCharMotionTarget(text, col, motion, char, isRepeat, count);
	if (targetCol === null) return null;
	return makeResult(lines, line, targetCol, false, false);
}

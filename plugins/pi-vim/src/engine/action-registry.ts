/**
 * Action registry — standalone commands that need no motion target.
 *
 * Task 7: each function now RETURNS EditIntent[] instead of calling ctx.host
 * imperatively. Cursor position after paste is computed analytically from the
 * pre-paste buffer state so no post-edit host reads are needed.
 *
 * Covers: mode entries (i a I A o O), visual entries (v V),
 * x / s / r, p / P, D / C / Y.
 * NOTE: dd/cc/yy doubled operators are special-cased in the evaluator.
 */

import {
	findFirstNonWhitespaceColumn,
	isBlankLine,
	getLineGraphemes,
} from "../vim/motions.js";
import { lineColToAbs, absToLineCol } from "../host/keystroke-bridge.js";
import { applyLinewiseOp, deleteCharwise } from "./operator-registry.js";
import type { EditIntent } from "./intent.js";
import type { Ctx } from "./state.js";
import { graphemeLenAt } from "./motion-registry.js";

// ---------------------------------------------------------------------------
// Mode entries
// ---------------------------------------------------------------------------

export function actionI(_ctx: Ctx): EditIntent[] {
	return [{ kind: "setMode", mode: "insert" }];
}

/** `a` — append after cursor (move right one grapheme, enter INSERT). */
export function actionA(ctx: Ctx): EditIntent[] {
	const { line, col } = ctx.host.getCursor();
	const text = ctx.host.getLines()[line] ?? "";
	const newCol = col + graphemeLenAt(text, col);
	return [
		{ kind: "moveCursor", to: { line, col: newCol } },
		{ kind: "setMode", mode: "insert" },
	];
}

/** `I` — insert at line start (col 0). */
export function actionBigI(ctx: Ctx): EditIntent[] {
	const { line } = ctx.host.getCursor();
	return [
		{ kind: "moveCursor", to: { line, col: 0 } },
		{ kind: "setMode", mode: "insert" },
	];
}

/** `A` — append at line end. */
export function actionBigA(ctx: Ctx): EditIntent[] {
	const { line } = ctx.host.getCursor();
	const col = (ctx.host.getLines()[line] ?? "").length;
	return [
		{ kind: "moveCursor", to: { line, col } },
		{ kind: "setMode", mode: "insert" },
	];
}

/**
 * `o` — open line below: signal INSERT, then insert `\n` at EOL.
 * Effect order (spec §2): setMode insert → replaceRange(EOL, \n).
 */
export function actionO(ctx: Ctx): EditIntent[] {
	const { line } = ctx.host.getCursor();
	const lines = ctx.host.getLines();
	const eolCol = (lines[line] ?? "").length;
	const eolAbs = lineColToAbs(lines, line, eolCol);
	return [
		{ kind: "setMode", mode: "insert" },
		{ kind: "replaceRange", range: { start: eolAbs, end: eolAbs }, text: "\n" },
	];
}

/**
 * `O` — open line above: signal INSERT, insert `\n` at line start, move up.
 */
export function actionBigO(ctx: Ctx): EditIntent[] {
	const { line } = ctx.host.getCursor();
	const lines = ctx.host.getLines();
	const lineStartAbsVal = lineColToAbs(lines, line, 0);
	return [
		{ kind: "setMode", mode: "insert" },
		// Insert "\n" at line start — pushes current content down one line.
		{ kind: "replaceRange", range: { start: lineStartAbsVal, end: lineStartAbsVal }, text: "\n" },
		// Move cursor to the newly created empty line (same line index now holds new blank line).
		{ kind: "moveCursor", to: { line, col: 0 } },
	];
}

// ---------------------------------------------------------------------------
// Visual entries
// ---------------------------------------------------------------------------

/**
 * `v` — enter charwise VISUAL (or exit if already in charwise VISUAL).
 * Anchors at the cursor when entering from NORMAL.
 */
export function actionV(ctx: Ctx): EditIntent[] {
	if (ctx.state.mode !== "visual" && ctx.state.mode !== "visual-line") {
		const cur = ctx.host.getCursor();
		ctx.state.visualAnchor = { line: cur.line, col: cur.col };
	}
	ctx.state.input.count = "";
	return [{ kind: "setMode", mode: "visual" }];
}

/**
 * `V` — enter VISUAL-LINE (or exit if already in VISUAL-LINE).
 * Anchors at the cursor when entering from NORMAL.
 */
export function actionBigV(ctx: Ctx): EditIntent[] {
	if (ctx.state.mode !== "visual" && ctx.state.mode !== "visual-line") {
		const cur = ctx.host.getCursor();
		ctx.state.visualAnchor = { line: cur.line, col: cur.col };
	}
	ctx.state.input.count = "";
	return [{ kind: "setMode", mode: "visual-line" }];
}

// ---------------------------------------------------------------------------
// Simple edits
// ---------------------------------------------------------------------------

/**
 * `x` / `{count}x` — delete `count` graphemes from under the cursor forward.
 * Stops at the end of the current line.
 */
export function actionX(ctx: Ctx, count: number): EditIntent[] {
	const lines = ctx.host.getLines();
	const { line, col } = ctx.host.getCursor();
	const text = lines[line] ?? "";
	let end = col;
	for (let i = 0; i < count && end < text.length; i++) {
		end += graphemeLenAt(text, end);
	}
	const lo = lineColToAbs(lines, line, col);
	const hi = lineColToAbs(lines, line, end);
	if (hi > lo) return deleteCharwise(ctx, lo, hi);
	return [];
}

/**
 * `X` / `{count}X` — delete `count` graphemes before the cursor on the current
 * line, clamping at column 0. No-op at column 0. The cursor stays on the same
 * grapheme (now shifted left).
 */
export function actionBigX(ctx: Ctx, count: number): EditIntent[] {
	const lines = ctx.host.getLines();
	const { line, col } = ctx.host.getCursor();
	const text = lines[line] ?? "";
	if (col <= 0) return [];
	// Walk `count` graphemes leftward from the cursor.
	const starts = getLineGraphemes(text).map((g) => g.start);
	let target = col;
	for (let i = 0; i < count; i++) {
		const prev = starts.filter((s) => s < target).pop();
		if (prev === undefined) { target = 0; break; }
		target = prev;
	}
	const lo = lineColToAbs(lines, line, target);
	const hi = lineColToAbs(lines, line, col);
	if (hi > lo) return deleteCharwise(ctx, lo, hi);
	return [];
}

/** `s` — delete `count` graphemes, then enter INSERT. */
export function actionS(ctx: Ctx, count: number): EditIntent[] {
	return [...actionX(ctx, count), { kind: "setMode", mode: "insert" }];
}

/** `D` — delete from cursor to end of current line. */
export function actionBigD(ctx: Ctx): EditIntent[] {
	const lines = ctx.host.getLines();
	const { line, col } = ctx.host.getCursor();
	const text = lines[line] ?? "";
	const lo = lineColToAbs(lines, line, col);
	const hi = lineColToAbs(lines, line, text.length);
	if (hi > lo) return deleteCharwise(ctx, lo, hi);
	return [];
}

/** `C` — delete to EOL, then enter INSERT. */
export function actionBigC(ctx: Ctx): EditIntent[] {
	return [...actionBigD(ctx), { kind: "setMode", mode: "insert" }];
}

/** `Y` — yank current line + (count - 1) lines below, linewise. */
export function actionBigY(ctx: Ctx, count: number): EditIntent[] {
	const { line } = ctx.host.getCursor();
	return applyLinewiseOp(ctx, "y", line, line + count - 1);
}

// ---------------------------------------------------------------------------
// Paste
// ---------------------------------------------------------------------------

/**
 * `p` / `P` — paste the unnamed register `count` times.
 *
 * Cursor position after paste is computed analytically (no post-insert
 * getCursor() read). For charwise paste the final col is computed from
 * the insert position + text length. For linewise paste the target line is
 * derived from the block's first line.
 *
 * `postDeleteCursor` — optional override for the cursor position; used by
 * the visual-p path where the buffer has been visually deleted before paste
 * but the intents have not yet been applied.
 */
export function actionPaste(
	ctx: Ctx,
	count: number,
	after: boolean,
	postDeleteCursor?: { line: number; col: number },
): EditIntent[] {
	const reg = ctx.state.registers.get();
	if (reg === null || reg.text === "") return [];

	const lines = ctx.host.getLines();
	const { line } = postDeleteCursor ?? ctx.host.getCursor();

	if (reg.linewise) {
		const content = reg.text.endsWith("\n")
			? reg.text.slice(0, -1)
			: reg.text;
		const block = Array.from({ length: count }, () => content).join("\n");
		// Cursor target = first non-blank of block's first line.
		const blockFirstLine = block.split("\n")[0] ?? "";
		const targetCol = isBlankLine(blockFirstLine) ? 0 : findFirstNonWhitespaceColumn(blockFirstLine);

		if (after) {
			// Insert `\nblock` at EOL → new lines appear below current line.
			const eolCol = (lines[line] ?? "").length;
			const eolAbs = lineColToAbs(lines, line, eolCol);
			return [
				{ kind: "replaceRange", range: { start: eolAbs, end: eolAbs }, text: `\n${block}` },
				{ kind: "moveCursor", to: { line: line + 1, col: targetCol } },
			];
		} else {
			// Insert `block\n` at BOL → block appears at current line index.
			const lineStartAbsVal = lineColToAbs(lines, line, 0);
			return [
				{ kind: "replaceRange", range: { start: lineStartAbsVal, end: lineStartAbsVal }, text: `${block}\n` },
				{ kind: "moveCursor", to: { line, col: targetCol } },
			];
		}
	}

	// Charwise paste.
	const cur = postDeleteCursor ?? ctx.host.getCursor();
	const curAbs = lineColToAbs(lines, cur.line, cur.col);
	const onNonEmptyLine = (lines[cur.line] ?? "").length > 0;
	const insertAbs = after && onNonEmptyLine
		? curAbs + graphemeLenAt(ctx.host.getText(), curAbs)
		: curAbs;
	const text = reg.text.repeat(count);

	// Compute final cursor position analytically (no post-insert read).
	const { line: insertLine, col: insertCol } = absToLineCol(lines, insertAbs);
	const textGfx = getLineGraphemes(text);
	const lastG = textGfx.length > 0 ? textGfx[textGfx.length - 1] : null;
	const lastWidth = lastG !== null ? lastG.end - lastG.start : 1;
	const textParts = text.split("\n");
	const newlines = textParts.length - 1;
	const cLine = insertLine + newlines;
	const cCol = newlines === 0
		? insertCol + text.length
		: (textParts[textParts.length - 1] ?? "").length;
	const finalCol = cCol - lastWidth;

	return [
		{ kind: "replaceRange", range: { start: insertAbs, end: insertAbs }, text },
		{ kind: "moveCursor", to: { line: cLine, col: finalCol } },
	];
}

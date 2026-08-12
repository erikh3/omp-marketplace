/**
 * Action registry — standalone commands that need no motion target.
 *
 * Covers: mode entries (i a I A o O), visual entries (v V), ex (:),
 * x / s / r, p / P, u, D / C / Y. Each function performs its effects
 * imperatively via `ctx.host`.
 *
 * NOTE: dd/cc/yy doubled operators are special-cased in the evaluator
 * (they are "action" entries in the keymap but handled inline in dispatch).
 */

import {
	findFirstNonWhitespaceColumn,
	isBlankLine,
	getLineGraphemes,
} from "../vim/motions.js";
import { lineColToAbs, absToLineCol } from "../host/keystroke-bridge.js";
import { applyLinewiseOp, deleteCharwise } from "./operator-registry.js";
import type { Ctx } from "./state.js";

// ---------------------------------------------------------------------------
// Grapheme helper
// ---------------------------------------------------------------------------

/** UTF-16 length of the grapheme cluster starting at absolute offset `abs`. */
function graphemeLenAt(text: string, abs: number): number {
	const WINDOW = 16;
	const seg = getLineGraphemes(text.slice(abs, abs + WINDOW))[0];
	return seg ? seg.end - seg.start : 1;
}


// ---------------------------------------------------------------------------
// Mode entries
// ---------------------------------------------------------------------------

export function actionI(ctx: Ctx): void {
	ctx.host.signalMode("insert");
}

/** `a` — append after cursor (move right one grapheme, enter INSERT). */
export function actionA(ctx: Ctx): void {
	const { line, col } = ctx.host.getCursor();
	const text = ctx.host.getLines()[line] ?? "";
	const newCol = col + graphemeLenAt(text, col);
	ctx.host.moveCursor({ line, col: newCol });
	ctx.host.signalMode("insert");
}

/** `I` — insert at line start (col 0). */
export function actionBigI(ctx: Ctx): void {
	const { line } = ctx.host.getCursor();
	ctx.host.moveCursor({ line, col: 0 });
	ctx.host.signalMode("insert");
}

/** `A` — append at line end. */
export function actionBigA(ctx: Ctx): void {
	const { line } = ctx.host.getCursor();
	const col = (ctx.host.getLines()[line] ?? "").length;
	ctx.host.moveCursor({ line, col });
	ctx.host.signalMode("insert");
}

/**
 * `o` — open line below: signal INSERT, then insert `\n` at EOL.
 * Effect order (spec §2): set INSERT → insert \n.
 */
export function actionO(ctx: Ctx): void {
	const { line } = ctx.host.getCursor();
	const lines = ctx.host.getLines();
	const eolCol = (lines[line] ?? "").length;
	const eolAbs = lineColToAbs(lines, line, eolCol);
	ctx.host.signalMode("insert");
	// replaceRange({eolAbs, eolAbs}, "\n") = #moveToAbs(eolAbs) + insertText("\n")
	ctx.host.replaceRange({ start: eolAbs, end: eolAbs }, "\n");
}

/**
 * `O` — open line above: signal INSERT, insert `\n` at line start, move up.
 * Original: moveToLineStart → insertText("\n") → handleDraftEdit(up) → setMode("insert").
 */
export function actionBigO(ctx: Ctx): void {
	const { line } = ctx.host.getCursor();
	const lines = ctx.host.getLines();
	const lineStartAbsVal = lineColToAbs(lines, line, 0);
	ctx.host.signalMode("insert");
	// Insert "\n" at line start — pushes current content down one line.
	ctx.host.replaceRange({ start: lineStartAbsVal, end: lineStartAbsVal }, "\n");
	// Move cursor up to the newly created empty line.
	ctx.host.moveCursor({ line, col: 0 });
}

// ---------------------------------------------------------------------------
// Visual entries
// ---------------------------------------------------------------------------

/**
 * `v` — enter charwise VISUAL (or exit if already in charwise VISUAL).
 * Anchors at the cursor when entering from NORMAL.
 */
export function actionV(ctx: Ctx): void {
	if (ctx.state.mode !== "visual" && ctx.state.mode !== "visual-line") {
		const cur = ctx.host.getCursor();
		ctx.state.visualAnchor = { line: cur.line, col: cur.col };
	}
	ctx.state.input.count = "";
	ctx.host.signalMode("visual");
}

/**
 * `V` — enter VISUAL-LINE (or exit if already in VISUAL-LINE).
 * Anchors at the cursor when entering from NORMAL.
 */
export function actionBigV(ctx: Ctx): void {
	if (ctx.state.mode !== "visual" && ctx.state.mode !== "visual-line") {
		const cur = ctx.host.getCursor();
		ctx.state.visualAnchor = { line: cur.line, col: cur.col };
	}
	ctx.state.input.count = "";
	ctx.host.signalMode("visual-line");
}

// ---------------------------------------------------------------------------
// Simple edits
// ---------------------------------------------------------------------------

/**
 * `x` / `{count}x` — delete `count` graphemes from under the cursor forward.
 * Stops at the end of the current line.
 */
export function actionX(ctx: Ctx, count: number): void {
	const lines = ctx.host.getLines();
	const { line, col } = ctx.host.getCursor();
	const text = lines[line] ?? "";
	let end = col;
	for (let i = 0; i < count && end < text.length; i++) {
		end += graphemeLenAt(text, end);
	}
	const lo = lineColToAbs(lines, line, col);
	const hi = lineColToAbs(lines, line, end);
	if (hi > lo) deleteCharwise(ctx, lo, hi);
}

/** `s` — delete `count` graphemes, then enter INSERT. */
export function actionS(ctx: Ctx, count: number): void {
	actionX(ctx, count);
	ctx.host.signalMode("insert");
}

/** `D` — delete from cursor to end of current line. */
export function actionBigD(ctx: Ctx): void {
	const lines = ctx.host.getLines();
	const { line, col } = ctx.host.getCursor();
	const text = lines[line] ?? "";
	const lo = lineColToAbs(lines, line, col);
	const hi = lineColToAbs(lines, line, text.length);
	if (hi > lo) deleteCharwise(ctx, lo, hi);
}

/** `C` — delete to EOL, then enter INSERT. */
export function actionBigC(ctx: Ctx): void {
	actionBigD(ctx);
	ctx.host.signalMode("insert");
}

/** `Y` — yank current line + (count - 1) lines below, linewise. */
export function actionBigY(ctx: Ctx, count: number): void {
	const { line } = ctx.host.getCursor();
	applyLinewiseOp(ctx, "y", line, line + count - 1);
}

// ---------------------------------------------------------------------------
// Paste
// ---------------------------------------------------------------------------

/**
 * `p` / `P` — paste the unnamed register `count` times.
 *
 * Charwise: `p` (after=true) inserts after the cursor grapheme (unless line is
 * empty), `P` inserts at the cursor. Cursor rests on the last pasted grapheme.
 *
 * Linewise: `p` inserts new line(s) below the current line, `P` above it.
 * Cursor rests at the first non-blank of the first pasted line.
 *
 * Replicates `#paste(count, after)` exactly.
 */
export function actionPaste(ctx: Ctx, count: number, after: boolean): void {
	const reg = ctx.state.registers.get();
	if (reg === null || reg.text === "") return;

	const lines = ctx.host.getLines();
	const { line } = ctx.host.getCursor();

	if (reg.linewise) {
		const content = reg.text.endsWith("\n")
			? reg.text.slice(0, -1)
			: reg.text;
		const block = Array.from({ length: count }, () => content).join("\n");

		if (after) {
			// Insert `\nblock` at EOL of current line → new content appears on the line(s) below.
			const eolCol = (lines[line] ?? "").length;
			const eolAbs = lineColToAbs(lines, line, eolCol);
			ctx.host.replaceRange({ start: eolAbs, end: eolAbs }, `\n${block}`);
			gotoLineFirstNonWs(ctx, line + 1);
		} else {
			// Insert `block\n` at BOL of current line → new content appears on the line(s) above.
			const lineStartAbsVal = lineColToAbs(lines, line, 0);
			ctx.host.replaceRange(
				{ start: lineStartAbsVal, end: lineStartAbsVal },
				`${block}\n`,
			);
			gotoLineFirstNonWs(ctx, line);
		}
		return;
	}

	// Charwise paste.
	const { line: curLine, col: curCol } = ctx.host.getCursor();
	const curAbs = lineColToAbs(lines, curLine, curCol);
	const onNonEmptyLine = (lines[curLine] ?? "").length > 0;
	const insertAbs =
		after && onNonEmptyLine
			? curAbs + graphemeLenAt(ctx.host.getText(), curAbs)
			: curAbs;
	const text = reg.text.repeat(count);

	// replaceRange({insertAbs, insertAbs}, text) = #moveToAbs(insertAbs) + insertText(text)
	ctx.host.replaceRange({ start: insertAbs, end: insertAbs }, text);

	// Vim rests the cursor on the LAST pasted grapheme.
	// After replaceRange, the cursor is one past the last pasted char.
	// Step back by the UTF-16 width of the last grapheme in `text`.
	const textGfx = getLineGraphemes(text);
	const lastG = textGfx.length > 0 ? textGfx[textGfx.length - 1] : null;
	const lastWidth = lastG !== null ? lastG.end - lastG.start : 1;
	const { line: cLine, col: cCol } = ctx.host.getCursor();
	ctx.host.moveCursor({ line: cLine, col: cCol - lastWidth });
}

/** Park cursor at the first non-blank of `lineIdx` (for linewise paste). */
function gotoLineFirstNonWs(ctx: Ctx, lineIdx: number): void {
	const lines = ctx.host.getLines();
	const target = Math.max(0, Math.min(lineIdx, lines.length - 1));
	const text = lines[target] ?? "";
	const col = isBlankLine(text) ? 0 : findFirstNonWhitespaceColumn(text);
	ctx.host.moveCursor({ line: target, col });
}

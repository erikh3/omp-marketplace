/**
 * Operator registry — named operators (d, c, y) applied to a resolved range.
 *
 * Task 7: each function now RETURNS EditIntent[] instead of calling ctx.host
 * imperatively. Register state is set explicitly here (before the intent is
 * returned) so that applyIntents never needs to touch the register.
 *
 * The previous reliance on ModalVimEditor.#deleteAbsRange → #yankToRegister
 * side-effect is replaced by explicit `ctx.state.registers.set(...)` calls.
 */

import {
	findFirstNonWhitespaceColumn,
	isBlankLine,
} from "../vim/motions.js";
import { lineColToAbs, absToLineCol } from "../host/keystroke-bridge.js";
import type { EditIntent } from "./intent.js";
import type { Ctx } from "./state.js";
import type { Operator } from "./state.js";

// ---------------------------------------------------------------------------
// Charwise operators
// ---------------------------------------------------------------------------

/**
 * Delete the half-open range `[lo, hi)` charwise.
 * Explicitly sets the charwise register to the deleted text.
 */
export function deleteCharwise(ctx: Ctx, lo: number, hi: number): EditIntent[] {
	if (hi <= lo) return [];
	const text = ctx.host.getText().slice(lo, hi);
	ctx.state.registers.set({ text, linewise: false }, "delete");
	return [{ kind: "replaceRange", range: { start: lo, end: hi }, text: "" }];
}

/**
 * Yank the half-open range `[lo, hi)` charwise into the register.
 * Buffer is NOT modified; cursor parks at `lo`.
 */
export function yankCharwise(ctx: Ctx, lo: number, hi: number): EditIntent[] {
	const text = ctx.host.getText().slice(lo, hi);
	ctx.state.registers.set({ text, linewise: false }, "yank");
	const { line, col } = absToLineCol(ctx.host.getLines(), lo);
	return [{ kind: "moveCursor", to: { line, col } }];
}

// ---------------------------------------------------------------------------
// Linewise operators
// ---------------------------------------------------------------------------

/**
 * Delete whole lines `[startLine, endLine]` linewise.
 * Adjusts lo/hi to include the right newlines (BOF/EOF aware).
 * Explicitly sets the linewise register to the deleted lines.
 */
function deleteLinewise(
	ctx: Ctx,
	startLine: number,
	endLine: number,
): EditIntent[] {
	const lines = ctx.host.getLines();
	const last = lines.length - 1;
	const s = Math.max(0, Math.min(startLine, last));
	const e = Math.max(s, Math.min(endLine, last));
	let lo: number;
	let hi: number;
	if (e < last) {
		lo = lineColToAbs(lines, s, 0);
		hi = lineColToAbs(lines, e + 1, 0);
	} else if (s > 0) {
		lo = lineColToAbs(lines, s - 1, (lines[s - 1] ?? "").length);
		hi = lineColToAbs(lines, e, (lines[e] ?? "").length);
	} else {
		lo = 0;
		hi = lineColToAbs(lines, e, (lines[e] ?? "").length);
	}
	// Capture the linewise payload BEFORE the delete intent is emitted.
	const payload = `${lines.slice(s, e + 1).join("\n")}\n`;
	ctx.state.registers.set({ text: payload, linewise: true }, "delete");
	return [{ kind: "replaceRange", range: { start: lo, end: hi }, text: "" }];
}

/**
 * Collapse lines `[startLine, endLine]` to a single empty line, then enter
 * INSERT mode. The line survives; only its text (and joining newlines) is
 * removed. Saves the collapsed range linewise in the register.
 */
function changeLinewise(
	ctx: Ctx,
	startLine: number,
	endLine: number,
): EditIntent[] {
	const lines = ctx.host.getLines();
	const last = lines.length - 1;
	const s = Math.max(0, Math.min(startLine, last));
	const e = Math.max(s, Math.min(endLine, last));
	const lo = lineColToAbs(lines, s, 0);
	const hi = lineColToAbs(lines, e, (lines[e] ?? "").length);
	const payload = `${lines.slice(s, e + 1).join("\n")}\n`;
	ctx.state.registers.set({ text: payload, linewise: true }, "delete");
	return [
		{ kind: "replaceRange", range: { start: lo, end: hi }, text: "" },
		{ kind: "setMode", mode: "insert" },
	];
}

/**
 * Yank whole lines `[startLine, endLine]` linewise.
 * Buffer is NOT modified; cursor parks at the first non-blank of startLine.
 */
function yankLinewise(
	ctx: Ctx,
	startLine: number,
	endLine: number,
): EditIntent[] {
	const lines = ctx.host.getLines();
	const last = lines.length - 1;
	const s = Math.max(0, Math.min(startLine, last));
	const e = Math.max(s, Math.min(endLine, last));
	ctx.state.registers.set(
		{ text: `${lines.slice(s, e + 1).join("\n")}\n`, linewise: true },
		"yank",
	);
	const text = lines[s] ?? "";
	const col = isBlankLine(text) ? 0 : findFirstNonWhitespaceColumn(text);
	return [{ kind: "moveCursor", to: { line: s, col } }];
}

// ---------------------------------------------------------------------------
// Dispatcher — apply an operator charwise or linewise
// ---------------------------------------------------------------------------

/** Apply the operator charwise over the absolute half-open range [lo, hi). */
export function applyCharwiseOp(
	ctx: Ctx,
	op: Operator,
	lo: number,
	hi: number,
): EditIntent[] {
	if (op === "y") return yankCharwise(ctx, lo, hi);
	const intents = deleteCharwise(ctx, lo, hi);
	if (op === "c") intents.push({ kind: "setMode", mode: "insert" });
	return intents;
}

/** Apply the operator linewise over lines [top, bottom]. */
export function applyLinewiseOp(
	ctx: Ctx,
	op: Operator,
	top: number,
	bottom: number,
): EditIntent[] {
	if (op === "y") return yankLinewise(ctx, top, bottom);
	if (op === "c") return changeLinewise(ctx, top, bottom);
	return deleteLinewise(ctx, top, bottom);
}

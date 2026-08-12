/**
 * Operator registry — named operators (d, c, y) applied to a resolved range.
 *
 * Each operator performs its imperative effects via `ctx.host` (HostEffects)
 * and `ctx.state.registers`. No EditIntent is returned yet (Task 7 adds that).
 *
 * Register discipline:
 *   `ctx.host.replaceRange` internally calls `#deleteAbsRange` which writes the
 *   deleted bytes charwise to the unnamed register. For linewise operations we
 *   overwrite the register with the linewise payload afterwards, exactly as the
 *   original `#deleteLineRange` did.
 */

import {
	findFirstNonWhitespaceColumn,
	isBlankLine,
} from "../vim/motions.js";
import { lineColToAbs, absToLineCol } from "../host/keystroke-bridge.js";
import type { Ctx } from "./state.js";
import type { Operator } from "./state.js";

// ---------------------------------------------------------------------------
// Charwise operators
// ---------------------------------------------------------------------------

/**
 * Delete the half-open range `[lo, hi)` charwise.
 *
 * `replaceRange` internally calls `#deleteAbsRange` which already writes the
 * removed text to the unnamed register as charwise. No extra register write.
 */
export function deleteCharwise(ctx: Ctx, lo: number, hi: number): void {
	if (hi <= lo) return;
	ctx.host.replaceRange({ start: lo, end: hi }, "");
}

/**
 * Yank the half-open range `[lo, hi)` charwise into the register.
 * Buffer is NOT modified; cursor parks at `lo`.
 */
export function yankCharwise(ctx: Ctx, lo: number, hi: number): void {
	const text = ctx.host.getText().slice(lo, hi);
	ctx.state.registers.set({ text, linewise: false });
	const { line, col } = absToLineCol(ctx.host.getLines(), lo);
	ctx.host.moveCursor({ line, col });
}

// ---------------------------------------------------------------------------
// Linewise operators
// ---------------------------------------------------------------------------

/**
 * Delete whole lines `[startLine, endLine]` linewise.
 * Adjusts lo/hi to include the right newlines (BOF/EOF aware).
 */
export function deleteLinewise(
	ctx: Ctx,
	startLine: number,
	endLine: number,
): void {
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
	// Capture payload BEFORE delete (replaceRange clobbers charwise register).
	const payload = `${lines.slice(s, e + 1).join("\n")}\n`;
	ctx.host.replaceRange({ start: lo, end: hi }, "");
	// Overwrite the charwise register with the linewise payload.
	ctx.state.registers.set({ text: payload, linewise: true });
}

/**
 * Collapse lines `[startLine, endLine]` to a single empty line, then enter
 * INSERT mode. The line survives; only its text (and joining newlines) is
 * removed. Saves the collapsed range linewise in the register.
 */
export function changeLinewise(
	ctx: Ctx,
	startLine: number,
	endLine: number,
): void {
	const lines = ctx.host.getLines();
	const last = lines.length - 1;
	const s = Math.max(0, Math.min(startLine, last));
	const e = Math.max(s, Math.min(endLine, last));
	const lo = lineColToAbs(lines, s, 0);
	const hi = lineColToAbs(lines, e, (lines[e] ?? "").length);
	const payload = `${lines.slice(s, e + 1).join("\n")}\n`;
	ctx.host.replaceRange({ start: lo, end: hi }, "");
	ctx.state.registers.set({ text: payload, linewise: true });
	ctx.host.signalMode("insert");
}

/**
 * Yank whole lines `[startLine, endLine]` linewise.
 * Buffer is NOT modified; cursor parks at the first non-blank of startLine.
 */
export function yankLinewise(
	ctx: Ctx,
	startLine: number,
	endLine: number,
): void {
	const lines = ctx.host.getLines();
	const last = lines.length - 1;
	const s = Math.max(0, Math.min(startLine, last));
	const e = Math.max(s, Math.min(endLine, last));
	ctx.state.registers.set({
		text: `${lines.slice(s, e + 1).join("\n")}\n`,
		linewise: true,
	});
	const text = lines[s] ?? "";
	const col = isBlankLine(text) ? 0 : findFirstNonWhitespaceColumn(text);
	ctx.host.moveCursor({ line: s, col });
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
): void {
	if (op === "y") {
		yankCharwise(ctx, lo, hi);
		return;
	}
	deleteCharwise(ctx, lo, hi);
	if (op === "c") ctx.host.signalMode("insert");
}

/** Apply the operator linewise over lines [top, bottom]. */
export function applyLinewiseOp(
	ctx: Ctx,
	op: Operator,
	top: number,
	bottom: number,
): void {
	if (op === "y") {
		yankLinewise(ctx, top, bottom);
		return;
	}
	if (op === "c") {
		changeLinewise(ctx, top, bottom);
		return;
	}
	deleteLinewise(ctx, top, bottom);
}

/**
 * Visual controller — visual selection geometry helpers.
 *
 * Wraps the vendored `vim/visual.ts` pure functions, lifting the current
 * anchor+cursor range computation out of `modal-editor.ts` so it can be
 * shared between the evaluator and the operator registry.
 */

import {
	getVisualLineRange,
	getInclusiveEndColumn,
	orderVisualEndpoints,
	clampVisualPosition,
} from "../vim/visual.js";
import { lineColToAbs } from "../host/keystroke-bridge.js";
import type { EditIntent } from "./intent.js";
import type { Ctx } from "./state.js";

/** Returns the anchor, clamped to the current buffer (text may have reflowed). */
export function getAnchor(ctx: Ctx): { line: number; col: number } {
	const cursor = ctx.host.getCursor();
	const raw = ctx.state.visualAnchor ?? cursor;
	return clampVisualPosition(raw, ctx.host.getLines() as string[]);
}

/** Absolute `[startAbs, endAbs)` span of the inclusive charwise selection. */
export function charwiseRange(ctx: Ctx): { startAbs: number; endAbs: number } {
	const lines = ctx.host.getLines();
	const anchor = getAnchor(ctx);
	const { start, end } = orderVisualEndpoints(anchor, ctx.host.getCursor());
	const endLine = lines[end.line] ?? "";
	const includesNewline =
		end.col >= endLine.length && end.line < lines.length - 1;
	return {
		startAbs: lineColToAbs(lines, start.line, start.col),
		endAbs:
			lineColToAbs(lines, end.line, 0) +
			getInclusiveEndColumn(endLine, end.col) +
			(includesNewline ? 1 : 0),
	};
}

/** `[startLine, endLine]` of the inclusive line-wise selection. */
export function linewiseRange(ctx: Ctx): { startLine: number; endLine: number } {
	const anchor = getAnchor(ctx);
	return getVisualLineRange(anchor, ctx.host.getCursor());
}

/**
 * Swap the visual anchor and the live cursor (the `o` action): the opposite
 * end of the selection becomes the new live cursor.
 */
export function swapEnds(ctx: Ctx): EditIntent[] {
	const anchor = getAnchor(ctx);
	const cursor = ctx.host.getCursor();
	ctx.state.visualAnchor = { line: cursor.line, col: cursor.col };
	return [{ kind: "moveCursor", to: { line: anchor.line, col: anchor.col } }];
}

/**
 * Evaluator — the dispatch entry point replacing `#handleNormal`.
 *
 * `evaluate(ctx, key)` is called from `modal-editor.handleInput` for every
 * NORMAL / OPERATOR-PENDING / VISUAL keystroke. It replicates the exact
 * dispatch logic of `#handleNormal` + `#handleNormalKey` + `#handleOperatorKey`
 * + `#handleVisual` using the registry functions and the keymap.
 *
 * For Task 6 the evaluator calls `ctx.host` (HostEffects) methods imperatively.
 * EditIntent + runKey (Task 7) will layer on top later.
 */

import { canonicalKeyId, parseKey, matchesKey } from "@oh-my-pi/pi-tui";

import {
	reverseCharMotion,
	type WordMotionClass,
} from "../vim/motions.js";
import {
	resolveWordTextObjectRange,
	resolveDelimitedTextObjectRange,
} from "../vim/text-objects.js";
import { lineColToAbs } from "../host/keystroke-bridge.js";

import {
	resetInput,
	takeCount,
	hasPending,
	type Operator,
	type Ctx,
} from "./state.js";

import {
	type MotionResult,
	graphemeLenAt,
	motionH,
	motionL,
	motionJ,
	motionK,
	motionW,
	motionBigW,
	motionB,
	motionBigB,
	motionE,
	motionBigE,
	motion0,
	motionCaret,
	motionDollar,
	motionLBrace,
	motionRBrace,
	motionPercent,
	motionG,
	motionGg,
	charFindMotion,
} from "./motion-registry.js";

import {
	applyCharwiseOp,
	applyLinewiseOp,
	deleteCharwise,
	yankCharwise,
} from "./operator-registry.js";

import {
	actionI,
	actionA,
	actionBigI,
	actionBigA,
	actionO,
	actionBigO,
	actionV,
	actionBigV,
	actionX,
	actionS,
	actionBigD,
	actionBigC,
	actionBigY,
	actionPaste,
} from "./action-registry.js";

import {
	charwiseRange,
	linewiseRange,
	swapEnds,
	getAnchor,
} from "./visual-controller.js";

import { normalKeymap, operatorKeymap, visualActionKeymap } from "./keymap.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isEscape(data: string): boolean {
	return matchesKey(data, "escape") || data === "\x1b" || matchesKey(data, "ctrl+[");
}

function isAppChord(data: string): boolean {
	const parsed = parseKey(data);
	if (parsed === undefined) return false;
	const can = canonicalKeyId(parsed);
	if (can === "enter") return true;
	if (data === "\r" || data === "\n") return true;
	return can.includes("+") && !can.startsWith("shift+");
}

/** True if the current character is blank/whitespace (for cw→ce). */
function cursorOnBlank(ctx: Ctx): boolean {
	const { line, col } = ctx.host.getCursor();
	const ch = (ctx.host.getLines()[line] ?? "")[col];
	return ch === undefined || /\s/.test(ch);
}

/** Absolute offset of the cursor. */
function curAbs(ctx: Ctx): number {
	const { line, col } = ctx.host.getCursor();
	return lineColToAbs(ctx.host.getLines(), line, col);
}

/** Convert a MotionResult's target into an abs range against the cursor. */
function buildCharwiseRange(
	ctx: Ctx,
	motion: MotionResult,
	overrideInclusive?: boolean,
): { lo: number; hi: number } {
	const cur = curAbs(ctx);
	const inclusive = overrideInclusive !== undefined ? overrideInclusive : motion.inclusive;
	let lo = Math.min(cur, motion.targetAbs);
	let hi = Math.max(cur, motion.targetAbs);
	if (inclusive) hi += graphemeLenAt(ctx.host.getText(), hi);
	return { lo, hi };
}


// ---------------------------------------------------------------------------
// Main evaluator
// ---------------------------------------------------------------------------

/**
 * Evaluate one keystroke in NORMAL / OPERATOR-PENDING / VISUAL mode.
 *
 * Called from `handleInput` after `#beginChange()` and before `#commitChange()`.
 * Replicates the exact behavior of the original `#handleNormal` dispatch.
 */
export function evaluate(ctx: Ctx, data: string): void {
	const parsed = parseKey(data);
	const canonical = parsed !== undefined ? canonicalKeyId(parsed) : undefined;

	// ── 1. ESC ──────────────────────────────────────────────────────────────
	if (isEscape(data)) {
		if (ctx.state.mode === "visual" || ctx.state.mode === "visual-line") {
			// Drop selection, return to NORMAL
			ctx.state.visualAnchor = null;
			ctx.host.signalMode("normal");
			return;
		}
		if (hasPending(ctx.state)) {
			resetInput(ctx.state);
			return;
		}
		// No pending: forward Esc to base (lets a second Esc reach omp interrupt)
		ctx.host.forward(data);
		return;
	}

	// ── 2. Ctrl+r (redo) ────────────────────────────────────────────────────
	// Claimed BEFORE app-chord passthrough so it doesn't reach host history search
	if (canonical === "ctrl+r") {
		ctx.host.redo(takeCount(ctx.state));
		resetInput(ctx.state);
		return;
	}

	// ── 3. App chords + Enter ────────────────────────────────────────────────
	if (isAppChord(data)) {
		resetInput(ctx.state);
		ctx.host.forward(data);
		return;
	}

	// ── 4. Digit prefix ──────────────────────────────────────────────────────
	// Leading 0 is the "line start" motion; other digits accumulate count.
	if (
		/^[1-9]$/.test(data) ||
		(data === "0" && ctx.state.input.count !== "")
	) {
		ctx.state.input.count += data;
		return;
	}

	// ── 5. Pending: replace ──────────────────────────────────────────────────
	if (ctx.state.input.replacePending) {
		resolveReplace(ctx, data);
		return;
	}

	// ── 6. Pending: char-find ────────────────────────────────────────────────
	if (ctx.state.input.charPending !== null) {
		resolveCharFind(ctx, data);
		return;
	}

	// ── 7. Pending: text object ──────────────────────────────────────────────
	if (ctx.state.input.textObject !== null) {
		resolveTextObject(ctx, data);
		return;
	}

	// ── 8. Pending: operator ────────────────────────────────────────────────
	if (ctx.state.input.operator !== null) {
		handleOperatorKey(ctx, data);
		return;
	}

	// ── 9. Pending G ────────────────────────────────────────────────────────
	if (ctx.state.input.pendingG) {
		ctx.state.input.pendingG = false;
		if (data === "g") {
			const count = ctx.state.input.count;
			const hasCount = count !== "";
			const n = takeCount(ctx.state);
			const motion = motionGg(ctx, n, hasCount);
			moveOrLinewise(ctx, motion);
		}
		ctx.state.input.count = "";
		return;
	}

	// ── 10. Visual mode non-motion keys ─────────────────────────────────────
	if (ctx.state.mode === "visual" || ctx.state.mode === "visual-line") {
		// pendingG / charPending already handled above; other visual-specific
		// keys are checked here and, if consumed, we return.
		if (handleVisualKey(ctx, data)) return;
	}

	// ── 11. Normal key dispatch ──────────────────────────────────────────────
	handleNormalKey(ctx, data);
}

// ---------------------------------------------------------------------------
// Pending state resolvers
// ---------------------------------------------------------------------------

function resolveReplace(ctx: Ctx, data: string): void {
	ctx.state.input.replacePending = false;
	if (data.length === 0 || data.charCodeAt(0) < 0x20) {
		resetInput(ctx.state);
		return;
	}
	const { line, col } = ctx.host.getCursor();
	const text = ctx.host.getLines()[line] ?? "";
	if (col >= text.length) {
		resetInput(ctx.state);
		return;
	}
	// Replace the grapheme under cursor, then step back one (cursor stays on it).
	const lo = lineColToAbs(ctx.host.getLines(), line, col);
	const hi = lo + graphemeLenAt(text, col);
	// Use replaceRange: delete [lo,hi) then insert data at lo.
	ctx.host.replaceRange({ start: lo, end: hi }, data);
	// After replacement cursor is at lo + data.length (past the new char). Step back.
	ctx.host.moveCursor({ line, col });
	ctx.state.input.count = "";
}

function resolveCharFind(ctx: Ctx, data: string): void {
	const motion = ctx.state.input.charPending;
	ctx.state.input.charPending = null;
	if (motion === null) return;
	// Non-printable → cancel
	if (data.length === 0 || data.charCodeAt(0) < 0x20) {
		resetInput(ctx.state);
		return;
	}
	ctx.state.lastCharMotion = { motion, char: data };
	applyCharFind(ctx, motion, data, takeCount(ctx.state), false);
}

function applyCharFind(
	ctx: Ctx,
	motion: "f" | "F" | "t" | "T",
	char: string,
	count: number,
	isRepeat: boolean,
): void {
	const result = charFindMotion(ctx, motion, char, count, isRepeat);
	if (result === null) {
		resetInput(ctx.state);
		return;
	}
	// Forward f/t under operator: inclusive; backward F/T: exclusive
	const forward = motion === "f" || motion === "t";
	const inclusive = ctx.state.input.operator !== null && forward;
	const { lo, hi } = buildCharwiseRange(ctx, result, inclusive);

	if (ctx.state.input.operator !== null) {
		applyCharwiseMotion(ctx.state.input.operator, lo, hi);
	} else {
		ctx.host.moveCursor({ line: result.targetLine, col: result.targetCol });
		resetInput(ctx.state);
	}

	function applyCharwiseMotion(op: Operator, lo: number, hi: number): void {
		if (hi <= lo) { resetInput(ctx.state); return; }
		applyCharwiseOp(ctx, op, lo, hi);
		if (op !== "c") resetInput(ctx.state);
	}
}

function resolveTextObject(ctx: Ctx, objectKey: string): void {
	const kind = ctx.state.input.textObject;
	const op = ctx.state.input.operator;
	ctx.state.input.textObject = null;
	if (kind === null || op === null) {
		resetInput(ctx.state);
		return;
	}
	const text = ctx.host.getText();
	const cursor = curAbs(ctx);
	let range: { startAbs: number; endAbs: number } | null;
	if (objectKey === "w" || objectKey === "W") {
		const { line, col } = ctx.host.getCursor();
		const lines = ctx.host.getLines();
		const lineStartAbsVal = lineColToAbs(lines, line, 0);
		range = resolveWordTextObjectRange(
			lines[line] ?? "",
			lineStartAbsVal,
			col,
			kind,
			takeCount(ctx.state),
			objectKey === "W" ? "WORD" : "word",
		);
	} else {
		range = resolveDelimitedTextObjectRange(text, cursor, kind, objectKey);
	}
	if (range === null) {
		resetInput(ctx.state);
		return;
	}
	if (op === "y") {
		yankCharwise(ctx, range.startAbs, range.endAbs);
		resetInput(ctx.state);
		return;
	}
	deleteCharwise(ctx, range.startAbs, range.endAbs);
	if (op === "c") ctx.host.signalMode("insert");
	else resetInput(ctx.state);
}

// ---------------------------------------------------------------------------
// Operator-pending key handling
// ---------------------------------------------------------------------------

function handleOperatorKey(ctx: Ctx, data: string): void {
	const op = ctx.state.input.operator;
	if (op === null) return;

	// gg / G under operator → linewise between cursor and target line
	if (ctx.state.input.pendingG) {
		ctx.state.input.pendingG = false;
		if (data === "g") {
			const hasCount = ctx.state.input.count !== "";
			const n = takeCount(ctx.state);
			const motion = motionGg(ctx, n, hasCount);
			applyLinewiseFromMotion(ctx, op, motion);
		} else {
			resetInput(ctx.state);
		}
		return;
	}
	if (data === "g") {
		ctx.state.input.pendingG = true;
		return;
	}
	if (data === "G") {
		const hasCount = ctx.state.input.count !== "";
		const n = takeCount(ctx.state);
		const motion = motionG(ctx, n, hasCount);
		applyLinewiseFromMotion(ctx, op, motion);
		return;
	}

	// Doubled operators: dd / cc / yy → linewise on current line + count-1 below
	if (
		(op === "d" && data === "d") ||
		(op === "c" && data === "c") ||
		(op === "y" && data === "y")
	) {
		const count = takeCount(ctx.state);
		const { line } = ctx.host.getCursor();
		applyLinewiseOp(ctx, op, line, line + count - 1);
		if (op !== "c") resetInput(ctx.state);
		return;
	}

	// Text-object introducer (i / a)
	if (data === "i" || data === "a") {
		ctx.state.input.textObject = data;
		return;
	}

	// Char-find as operator motion
	if (data === "f" || data === "F" || data === "t" || data === "T") {
		ctx.state.input.charPending = data;
		return;
	}

	// Linewise j / k
	if (data === "j" || data === "k") {
		const count = takeCount(ctx.state);
		const { line } = ctx.host.getCursor();
		const other = data === "j" ? line + count : line - count;
		applyLinewiseOp(
			ctx,
			op,
			Math.min(line, other),
			Math.max(line, other),
		);
		if (op !== "c") resetInput(ctx.state);
		return;
	}

	// Charwise motions (reusing same target math as standalone)
	const count = takeCount(ctx.state);
	const lines = ctx.host.getLines();
	const { line, col } = ctx.host.getCursor();

	switch (data) {
		case "w": {
			// cw special form: on non-blank → ce (word end, inclusive)
			if (op === "c") {
				applyChangeWord(ctx, "word", count);
			} else {
				const m = motionW(ctx, count);
				const { lo, hi } = buildCharwiseRange(ctx, m);
				applyCharwiseMotion(op, lo, hi);
			}
			return;
		}
		case "W": {
			if (op === "c") {
				applyChangeWord(ctx, "WORD", count);
			} else {
				const m = motionBigW(ctx, count);
				const { lo, hi } = buildCharwiseRange(ctx, m);
				applyCharwiseMotion(op, lo, hi);
			}
			return;
		}
		case "b": {
			const m = motionB(ctx, count);
			const { lo, hi } = buildCharwiseRange(ctx, m);
			applyCharwiseMotion(op, lo, hi);
			return;
		}
		case "B": {
			const m = motionBigB(ctx, count);
			const { lo, hi } = buildCharwiseRange(ctx, m);
			applyCharwiseMotion(op, lo, hi);
			return;
		}
		case "e": {
			const m = motionE(ctx, count);
			const { lo, hi } = buildCharwiseRange(ctx, m);
			applyCharwiseMotion(op, lo, hi);
			return;
		}
		case "E": {
			const m = motionBigE(ctx, count);
			const { lo, hi } = buildCharwiseRange(ctx, m);
			applyCharwiseMotion(op, lo, hi);
			return;
		}
		case "$": {
			const m = motionDollar(ctx, count);
			const { lo, hi } = buildCharwiseRange(ctx, m);
			applyCharwiseMotion(op, lo, hi);
			return;
		}
		case "0": {
			const m = motion0(ctx, count);
			const { lo, hi } = buildCharwiseRange(ctx, m);
			applyCharwiseMotion(op, lo, hi);
			return;
		}
		case "^": {
			const m = motionCaret(ctx, count);
			const { lo, hi } = buildCharwiseRange(ctx, m);
			applyCharwiseMotion(op, lo, hi);
			return;
		}
		case "%": {
			const m = motionPercent(ctx, count);
			if (m === null) {
				resetInput(ctx.state);
				return;
			}
			// % under operator: inclusive (both directions)
			const { lo, hi } = buildCharwiseRange(ctx, m, true);
			applyCharwiseMotion(op, lo, hi);
			return;
		}
		case "l": {
			// l under operator: clamped to text.length (unlike standalone l)
			const text = lines[line] ?? "";
			let end = col;
			for (let i = 0; i < count && end < text.length; i++) {
				end += graphemeLenAt(text, end);
			}
			const lo2 = lineColToAbs(lines, line, col);
			const hi2 = lineColToAbs(lines, line, end);
			applyCharwiseMotion(op, lo2, hi2);
			return;
		}
		default:
			// Unknown motion: cancel the operator (vim behaviour).
			resetInput(ctx.state);
			return;
	}

	// Local helper to avoid captured-variable shadowing issues
	function applyCharwiseMotion(op: Operator, lo: number, hi: number): void {
		if (hi <= lo) { resetInput(ctx.state); return; }
		applyCharwiseOp(ctx, op, lo, hi);
		if (op !== "c") resetInput(ctx.state);
	}
}

/** `cw` / `cW` special form: on non-blank → ce (word end, inclusive). */
function applyChangeWord(ctx: Ctx, semanticClass: WordMotionClass, count: number): void {
	let motion: MotionResult;
	if (cursorOnBlank(ctx)) {
		// On whitespace: behave like w (exclusive)
		motion = semanticClass === "word"
			? motionW(ctx, count)
			: motionBigW(ctx, count);
	} else {
		// On non-blank: behave like e/E (inclusive)
		motion = semanticClass === "word"
			? motionE(ctx, count)
			: motionBigE(ctx, count);
	}
	const { lo, hi } = buildCharwiseRange(ctx, motion);
	if (hi <= lo) { resetInput(ctx.state); return; }
	deleteCharwise(ctx, lo, hi);
	ctx.host.signalMode("insert");
}

/** Apply a linewise operator given a linewise motion result. */
function applyLinewiseFromMotion(ctx: Ctx, op: Operator, motion: MotionResult): void {
	const { line } = ctx.host.getCursor();
	const targetLine = motion.targetLine;
	applyLinewiseOp(ctx, op, Math.min(line, targetLine), Math.max(line, targetLine));
	if (op !== "c") resetInput(ctx.state);
}

// ---------------------------------------------------------------------------
// Visual non-motion key handler
// ---------------------------------------------------------------------------

/**
 * Handle visual-specific keys. Returns true when consumed, false when the
 * key should fall through to the normal motion dispatch.
 */
function handleVisualKey(ctx: Ctx, data: string): boolean {
	// Let a mid-flight pendingG or charPending resolve normally (motions).
	// These were already checked before this function is called.

	const linewise = ctx.state.mode === "visual-line";

	const actionName = visualActionKeymap[data];
	if (actionName === undefined) return false;

	switch (actionName) {
		case "visual-v":
			if (linewise) ctx.host.signalMode("visual");
			else {
				ctx.state.visualAnchor = null;
				ctx.host.signalMode("normal");
			}
			return true;
		case "visual-V":
			if (linewise) {
				ctx.state.visualAnchor = null;
				ctx.host.signalMode("normal");
			} else ctx.host.signalMode("visual-line");
			return true;
		case "visual-d":
			applyVisualOperator(ctx, "d", linewise);
			return true;
		case "visual-c":
			applyVisualOperator(ctx, "c", linewise);
			return true;
		case "visual-D":
			applyVisualOperator(ctx, "d", true);
			return true;
		case "visual-C":
			applyVisualOperator(ctx, "c", true);
			return true;
		case "visual-y":
			applyVisualOperator(ctx, "y", linewise);
			return true;
		case "visual-Y":
			applyVisualOperator(ctx, "y", true);
			return true;
		case "visual-p": {
			// Visual paste: stash register, delete selection, restore, paste.
			const saved = ctx.state.registers.get();
			applyVisualOperator(ctx, "d", linewise);
			if (saved !== null) ctx.state.registers.set(saved);
			else ctx.state.registers.clear();
			actionPaste(ctx, 1, false);
			return true;
		}
		case "visual-o":
			swapEnds(ctx);
			return true;
		case "visual-:":
			// Swallowed in visual mode (no ex yet).
			return true;
		default:
			return false;
	}
}

/** Apply an operator to the live visual selection. */
function applyVisualOperator(
	ctx: Ctx,
	op: Operator,
	linewise: boolean,
): void {
	ctx.state.input.count = "";
	if (linewise) {
		const { startLine, endLine } = linewiseRange(ctx);
		ctx.state.visualAnchor = null;
		ctx.host.signalMode("normal");
		applyLinewiseOp(ctx, op, startLine, endLine);
		return;
	}
	const { startAbs, endAbs } = charwiseRange(ctx);
	ctx.state.visualAnchor = null;
	if (op === "y") {
		// Visual charwise yank: capture span, park at start, keep buffer.
		yankCharwise(ctx, startAbs, endAbs);
		ctx.host.signalMode("normal");
		return;
	}
	ctx.host.signalMode(op === "c" ? "insert" : "normal");
	deleteCharwise(ctx, startAbs, endAbs);
}

// ---------------------------------------------------------------------------
// Normal-key dispatch (no pending state)
// ---------------------------------------------------------------------------

function handleNormalKey(ctx: Ctx, data: string): void {
	const parsed = parseKey(data);
	const canonical = parsed !== undefined ? canonicalKeyId(parsed) : undefined;

	switch (data) {
		// Mode entries
		case "i": actionI(ctx); return;
		case "a": actionA(ctx); return;
		case "I": actionBigI(ctx); return;
		case "A": actionBigA(ctx); return;
		case "o": actionO(ctx); return;
		case "O": actionBigO(ctx); return;

		// Visual modes
		case "v": actionV(ctx); return;
		case "V": actionBigV(ctx); return;

		// Motions (arrow-like)
		case "h": {
			const m = motionH(ctx, takeCount(ctx.state));
			ctx.host.moveCursor({ line: m.targetLine, col: m.targetCol });
			return;
		}
		case "l": {
			const m = motionL(ctx, takeCount(ctx.state));
			ctx.host.moveCursor({ line: m.targetLine, col: m.targetCol });
			return;
		}
		case "j": {
			const m = motionJ(ctx, takeCount(ctx.state));
			ctx.host.moveCursor({ line: m.targetLine, col: m.targetCol });
			return;
		}
		case "k": {
			const m = motionK(ctx, takeCount(ctx.state));
			ctx.host.moveCursor({ line: m.targetLine, col: m.targetCol });
			return;
		}

		// Word motions
		case "w": {
			const m = motionW(ctx, takeCount(ctx.state));
			ctx.host.moveCursor({ line: m.targetLine, col: m.targetCol });
			return;
		}
		case "W": {
			const m = motionBigW(ctx, takeCount(ctx.state));
			ctx.host.moveCursor({ line: m.targetLine, col: m.targetCol });
			return;
		}
		case "b": {
			const m = motionB(ctx, takeCount(ctx.state));
			ctx.host.moveCursor({ line: m.targetLine, col: m.targetCol });
			return;
		}
		case "B": {
			const m = motionBigB(ctx, takeCount(ctx.state));
			ctx.host.moveCursor({ line: m.targetLine, col: m.targetCol });
			return;
		}
		case "e": {
			const m = motionE(ctx, takeCount(ctx.state));
			ctx.host.moveCursor({ line: m.targetLine, col: m.targetCol });
			return;
		}
		case "E": {
			const m = motionBigE(ctx, takeCount(ctx.state));
			ctx.host.moveCursor({ line: m.targetLine, col: m.targetCol });
			return;
		}

		// Line motions
		case "0": {
			const m = motion0(ctx, 1);
			ctx.host.moveCursor({ line: m.targetLine, col: m.targetCol });
			return;
		}
		case "^": {
			const m = motionCaret(ctx, 1);
			ctx.host.moveCursor({ line: m.targetLine, col: m.targetCol });
			return;
		}
		case "$": {
			const m = motionDollar(ctx, 1);
			ctx.host.moveCursor({ line: m.targetLine, col: m.targetCol });
			return;
		}

		// Paragraph motions
		case "{": {
			const m = motionLBrace(ctx, takeCount(ctx.state));
			ctx.host.moveCursor({ line: m.targetLine, col: m.targetCol });
			return;
		}
		case "}": {
			const m = motionRBrace(ctx, takeCount(ctx.state));
			ctx.host.moveCursor({ line: m.targetLine, col: m.targetCol });
			return;
		}

		// Matching pair
		case "%": {
			const m = motionPercent(ctx, 1);
			if (m === null) { resetInput(ctx.state); return; }
			ctx.host.moveCursor({ line: m.targetLine, col: m.targetCol });
			return;
		}

		// Char-find
		case "f":
		case "F":
		case "t":
		case "T":
			ctx.state.input.charPending = data;
			return;

		// Char-find repeat
		case ";": repeatCharFind(ctx, false); return;
		case ",": repeatCharFind(ctx, true); return;

		// Buffer jumps
		case "g":
			ctx.state.input.pendingG = true;
			return;
		case "G": {
			const hasCount = ctx.state.input.count !== "";
			const n = takeCount(ctx.state);
			const m = motionG(ctx, n, hasCount);
			ctx.host.moveCursor({ line: m.targetLine, col: m.targetCol });
			ctx.state.input.count = "";
			return;
		}

		// Edits
		case "u":
			ctx.host.undo(takeCount(ctx.state));
			return;
		case "x": actionX(ctx, takeCount(ctx.state)); return;
		case "r":
			ctx.state.input.replacePending = true;
			return;
		case "D": actionBigD(ctx); return;
		case "C": actionBigC(ctx); return;
		case "d": ctx.state.input.operator = "d"; return;
		case "c": ctx.state.input.operator = "c"; return;
		case "s": actionS(ctx, takeCount(ctx.state)); return;
		case "y": ctx.state.input.operator = "y"; return;
		case "Y": actionBigY(ctx, takeCount(ctx.state)); return;
		case "p": actionPaste(ctx, takeCount(ctx.state), true); return;
		case "P": actionPaste(ctx, takeCount(ctx.state), false); return;

		// Ex
		case ":":
			ctx.state.exBuffer = ":";
			ctx.host.signalEx(":");
			return;

		default:
			// Swallow every unmapped key: NORMAL never leaks text.
			return;
	}
}

// ---------------------------------------------------------------------------
// Char-find repeat (;  ,)
// ---------------------------------------------------------------------------

function repeatCharFind(ctx: Ctx, reverse: boolean): void {
	const last = ctx.state.lastCharMotion;
	if (last === null) return;
	const motion = reverse ? reverseCharMotion(last.motion) : last.motion;
	applyCharFind(ctx, motion, last.char, takeCount(ctx.state), true);
}

// ---------------------------------------------------------------------------
// Standalone + visual linewise motion helper
// ---------------------------------------------------------------------------

/**
 * Apply a motion result in a standalone or visual context:
 * - If there is an operator pending (shouldn't happen here, but guard), apply it.
 * - If linewise: move cursor to (targetLine, targetCol) without operator.
 * - If charwise: move cursor to the target.
 */
function moveOrLinewise(ctx: Ctx, motion: MotionResult): void {
	ctx.host.moveCursor({ line: motion.targetLine, col: motion.targetCol });
}

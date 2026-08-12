/**
 * Evaluator + boundary owner — dispatch entry point for the vim engine.
 *
 * `evaluate(ctx, key)` returns `{ intents: EditIntent[]; undoUnit: boolean }`.
 * `runKey(state, host, history, key)` is the SOLE owner of History.begin/commit.
 *
 * Task 7: engine units return EditIntent[] instead of calling ctx.host.
 * Exception: `u`/`Ctrl+r` still call ctx.host.undo/redo directly because they
 * are timeline operations (using History.undo/redo + setText restore) that
 * cannot be expressed as EditIntents.
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
import type { VimState } from "./state.js";

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

import type { EditIntent } from "./intent.js";
import { applyIntents } from "../host/adapter.js";
import type { HostEffects } from "../host/adapter.js";
import { History } from "../host/history.js";
import { absToLineCol } from "../host/keystroke-bridge.js";

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
// Motion function table & operator charwise helper
// ---------------------------------------------------------------------------

/** Motion function signature (motionPercent may return null; all others do not). */
type MotionFn = (ctx: Ctx, count: number) => MotionResult | null;

/**
 * `l` under operator-pending — advance `count` graphemes but clamp at line end.
 * Unlike standalone `l`, operator-l stops at the last character.
 */
function motionLOp(ctx: Ctx, count: number): MotionResult {
	const { line, col } = ctx.host.getCursor();
	const lines = ctx.host.getLines();
	const text = lines[line] ?? "";
	let end = col;
	for (let i = 0; i < count && end < text.length; i++) {
		end += graphemeLenAt(text, end);
	}
	return {
		targetAbs: lineColToAbs(lines, line, end),
		targetLine: line,
		targetCol: end,
		inclusive: false,
		linewise: false,
	};
}

/** Charwise motions indexed by keymap name. Index access may return undefined. */
const motionFns: Partial<Record<string, MotionFn>> = {
	h: motionH,
	l: motionL,
	j: motionJ,
	k: motionK,
	w: motionW,
	W: motionBigW,
	b: motionB,
	B: motionBigB,
	e: motionE,
	E: motionBigE,
	"0": motion0,
	"^": motionCaret,
	$: motionDollar,
	"{": motionLBrace,
	"}": motionRBrace,
	"%": motionPercent,
	"l-op": motionLOp,
};

/** Apply an operator to a charwise [lo, hi) range; reset input unless `c`. */
function applyCharwiseMotion(ctx: Ctx, op: Operator, lo: number, hi: number): EditIntent[] {
	if (hi <= lo) { resetInput(ctx.state); return []; }
	const intents = applyCharwiseOp(ctx, op, lo, hi);
	if (op !== "c") resetInput(ctx.state);
	return intents;
}

// ---------------------------------------------------------------------------
// EvaluateResult
// ---------------------------------------------------------------------------

export interface EvaluateResult {
	intents: EditIntent[];
	undoUnit: boolean;
}

// ---------------------------------------------------------------------------
// Main evaluator
// ---------------------------------------------------------------------------

/**
 * Evaluate one keystroke.
 *
 * Returns `{ intents, undoUnit }`. `undoUnit: true` for INSERT forwards and
 * completed NORMAL/VISUAL commands (including pure motions — `history.commit`'s
 * text-equality guard discards no-ops so the undo stack stays clean).
 * `undoUnit: false` for incomplete commands, Esc, and the timeline ops u/C-r.
 */
export function evaluate(ctx: Ctx, data: string): EvaluateResult {
	const parsed = parseKey(data);
	const canonical = parsed !== undefined ? canonicalKeyId(parsed) : undefined;

	// ── INSERT mode: forward passthrough (Esc handled by handleInput first) ──
	if (ctx.state.mode === "insert") {
		return { intents: [{ kind: "forward", data }], undoUnit: true };
	}

	// ── 1. ESC ──────────────────────────────────────────────────────────────
	if (isEscape(data)) {
		if (ctx.state.mode === "visual" || ctx.state.mode === "visual-line") {
			// Drop selection, return to NORMAL
			ctx.state.visualAnchor = null;
			return { intents: [{ kind: "setMode", mode: "normal" }], undoUnit: false };
		}
		if (hasPending(ctx.state)) {
			resetInput(ctx.state);
			return { intents: [], undoUnit: false };
		}
		// No pending: forward Esc to base (lets a second Esc reach omp interrupt)
		return { intents: [{ kind: "forward", data }], undoUnit: false };
	}

	// ── 2. Ctrl+r (redo) ────────────────────────────────────────────────────
	// Claimed BEFORE app-chord passthrough so it doesn't reach host history search.
	if (canonical === "ctrl+r") {
		ctx.host.redo(takeCount(ctx.state));
		resetInput(ctx.state);
		return { intents: [], undoUnit: false };
	}

	// ── 3. App chords + Enter ────────────────────────────────────────────────
	if (isAppChord(data)) {
		resetInput(ctx.state);
		return { intents: [{ kind: "forward", data }], undoUnit: true };
	}

	// ── 4. Digit prefix ──────────────────────────────────────────────────────
	// Leading 0 is the "line start" motion; other digits accumulate count.
	if (
		/^[1-9]$/.test(data) ||
		(data === "0" && ctx.state.input.count !== "")
	) {
		ctx.state.input.count += data;
		return { intents: [], undoUnit: false };
	}

	// ── 5. Pending: replace ──────────────────────────────────────────────────
	if (ctx.state.input.replacePending) {
		return { intents: resolveReplace(ctx, data), undoUnit: true };
	}

	// ── 6. Pending: char-find ────────────────────────────────────────────────
	if (ctx.state.input.charPending !== null) {
		return { intents: resolveCharFind(ctx, data), undoUnit: true };
	}

	// ── 7. Pending: text object ──────────────────────────────────────────────
	if (ctx.state.input.textObject !== null) {
		return { intents: resolveTextObject(ctx, data), undoUnit: true };
	}

	// ── 8. Pending: operator ────────────────────────────────────────────────
	if (ctx.state.input.operator !== null) {
		return { intents: handleOperatorKey(ctx, data), undoUnit: true };
	}

	// ── 9. Pending G ────────────────────────────────────────────────────────
	if (ctx.state.input.pendingG) {
		ctx.state.input.pendingG = false;
		if (data === "g") {
			const count = ctx.state.input.count;
			const hasCount = count !== "";
			const n = takeCount(ctx.state);
			const motion = motionGg(ctx, n, hasCount);
			ctx.state.input.count = "";
			return {
				intents: [{ kind: "moveCursor", to: { line: motion.targetLine, col: motion.targetCol } }],
				undoUnit: false,
			};
		}
		ctx.state.input.count = "";
		return { intents: [], undoUnit: false };
	}

	// ── 10. Visual mode non-motion keys ─────────────────────────────────────
	if (ctx.state.mode === "visual" || ctx.state.mode === "visual-line") {
		// pendingG / charPending already handled above; other visual-specific
		// keys are checked here and, if consumed, we return.
		const visualIntents = handleVisualKey(ctx, data);
		if (visualIntents !== null) {
			return { intents: visualIntents, undoUnit: true };
		}
	}

	// ── u (undo) — timeline operation; must not open an undo bracket ────────
	if (data === "u") {
		ctx.host.undo(takeCount(ctx.state));
		return { intents: [], undoUnit: false };
	}

	// ── 11. Normal key dispatch ──────────────────────────────────────────────
	return handleNormalKey(ctx, data);
}

// ---------------------------------------------------------------------------
// runKey — the SOLE owner of History.begin/commit
// ---------------------------------------------------------------------------

/**
 * The single undo-boundary owner.
 *
 * Opens exactly one History unit when `undoUnit: true`, applies all intents
 * in strict emission order, then commits. `history.commit` is a no-op when
 * the buffer text did not change (pure motions, empty-register paste, etc.).
 */
export function runKey(
	state: VimState,
	host: HostEffects,
	history: History,
	key: string,
): void {
	const { intents, undoUnit } = evaluate({ state, host }, key);
	if (undoUnit) history.begin(host.getText(), host.getCursor());
	applyIntents(host, intents);
	if (undoUnit) history.commit(host.getText());
}

// ---------------------------------------------------------------------------
// Pending state resolvers
// ---------------------------------------------------------------------------

function resolveReplace(ctx: Ctx, data: string): EditIntent[] {
	ctx.state.input.replacePending = false;
	if (data.length === 0 || data.charCodeAt(0) < 0x20) {
		resetInput(ctx.state);
		return [];
	}
	const { line, col } = ctx.host.getCursor();
	const text = ctx.host.getLines()[line] ?? "";
	if (col >= text.length) {
		resetInput(ctx.state);
		return [];
	}
	// Replace the grapheme under cursor, then step back one (cursor stays on it).
	const lo = lineColToAbs(ctx.host.getLines(), line, col);
	const hi = lo + graphemeLenAt(text, col);
	ctx.state.input.count = "";
	// replaceRange: delete [lo,hi) then insert data at lo; cursor moves to col.
	return [
		{ kind: "replaceRange", range: { start: lo, end: hi }, text: data },
		{ kind: "moveCursor", to: { line, col } },
	];
}

function resolveCharFind(ctx: Ctx, data: string): EditIntent[] {
	const motion = ctx.state.input.charPending;
	ctx.state.input.charPending = null;
	if (motion === null) return [];
	// Non-printable → cancel
	if (data.length === 0 || data.charCodeAt(0) < 0x20) {
		resetInput(ctx.state);
		return [];
	}
	ctx.state.lastCharMotion = { motion, char: data };
	return applyCharFind(ctx, motion, data, takeCount(ctx.state), false);
}

function applyCharFind(
	ctx: Ctx,
	motion: "f" | "F" | "t" | "T",
	char: string,
	count: number,
	isRepeat: boolean,
): EditIntent[] {
	const result = charFindMotion(ctx, motion, char, count, isRepeat);
	if (result === null) {
		resetInput(ctx.state);
		return [];
	}
	// Forward f/t under operator: inclusive; backward F/T: exclusive
	const forward = motion === "f" || motion === "t";
	const inclusive = ctx.state.input.operator !== null && forward;
	const { lo, hi } = buildCharwiseRange(ctx, result, inclusive);

	if (ctx.state.input.operator !== null) {
		return applyCharwiseMotion(ctx, ctx.state.input.operator, lo, hi);
	}
	resetInput(ctx.state);
	return [{ kind: "moveCursor", to: { line: result.targetLine, col: result.targetCol } }];
}

function resolveTextObject(ctx: Ctx, objectKey: string): EditIntent[] {
	const kind = ctx.state.input.textObject;
	const op = ctx.state.input.operator;
	ctx.state.input.textObject = null;
	if (kind === null || op === null) {
		resetInput(ctx.state);
		return [];
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
		return [];
	}
	if (op === "y") {
		const intents = yankCharwise(ctx, range.startAbs, range.endAbs);
		resetInput(ctx.state);
		return intents;
	}
	const intents = deleteCharwise(ctx, range.startAbs, range.endAbs);
	if (op === "c") {
		intents.push({ kind: "setMode", mode: "insert" });
	} else {
		resetInput(ctx.state);
	}
	return intents;
}

// ---------------------------------------------------------------------------
// Operator-pending key handling
// ---------------------------------------------------------------------------

function handleOperatorKey(ctx: Ctx, data: string): EditIntent[] {
	const op = ctx.state.input.operator;
	if (op === null) return [];

	// ── Pending gg: second 'g' completes the gg motion ──────────────────────
	if (ctx.state.input.pendingG) {
		ctx.state.input.pendingG = false;
		if (data === "g") {
			const hasCount = ctx.state.input.count !== "";
			const n = takeCount(ctx.state);
			const motion = motionGg(ctx, n, hasCount);
			return applyLinewiseFromMotion(ctx, op, motion);
		}
		resetInput(ctx.state);
		return [];
	}

	// ── Doubled operators: dd / cc / yy → linewise on current line ──────────
	if (
		(op === "d" && data === "d") ||
		(op === "c" && data === "c") ||
		(op === "y" && data === "y")
	) {
		const count = takeCount(ctx.state);
		const { line } = ctx.host.getCursor();
		const intents = applyLinewiseOp(ctx, op, line, line + count - 1);
		if (op !== "c") resetInput(ctx.state);
		return intents;
	}

	// ── Keymap-driven dispatch ───────────────────────────────────────────────
	const command = operatorKeymap[data];
	if (command === undefined) {
		resetInput(ctx.state);
		return [];
	}

	switch (command.type) {
		case "textobject-intro":
			ctx.state.input.textObject = command.kind;
			return [];

		case "motion-await-char":
			ctx.state.input.charPending = command.name;
			return [];

		case "motion-gg":
			ctx.state.input.pendingG = true;
			return [];

		case "motion-G": {
			const hasCount = ctx.state.input.count !== "";
			const n = takeCount(ctx.state);
			const motion = motionG(ctx, n, hasCount);
			return applyLinewiseFromMotion(ctx, op, motion);
		}

		case "motion": {
			const count = takeCount(ctx.state);
			const { name, inclusiveOverride, changeWord } = command;
			// cw / cW special form: on non-blank, behave like ce / cE (word-end, inclusive)
			if (changeWord && op === "c") {
				return applyChangeWord(ctx, name === "W" ? "WORD" : "word", count);
			}
			const fn = motionFns[name];
			if (fn === undefined) { resetInput(ctx.state); return []; }
			const m = fn(ctx, count);
			if (m === null) { resetInput(ctx.state); return []; }
			if (m.linewise) {
				return applyLinewiseFromMotion(ctx, op, m);
			}
			const { lo, hi } = buildCharwiseRange(ctx, m, inclusiveOverride);
			return applyCharwiseMotion(ctx, op, lo, hi);
		}

		default:
			// ActionCommand / OperatorCommand are not valid in operator-pending; cancel.
			resetInput(ctx.state);
			return [];
	}
}

/** `cw` / `cW` special form: on non-blank → ce (word end, inclusive). */
function applyChangeWord(ctx: Ctx, semanticClass: WordMotionClass, count: number): EditIntent[] {
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
	if (hi <= lo) { resetInput(ctx.state); return []; }
	const intents = deleteCharwise(ctx, lo, hi);
	intents.push({ kind: "setMode", mode: "insert" });
	return intents;
}

/** Apply a linewise operator given a linewise motion result. */
function applyLinewiseFromMotion(ctx: Ctx, op: Operator, motion: MotionResult): EditIntent[] {
	const { line } = ctx.host.getCursor();
	const targetLine = motion.targetLine;
	const intents = applyLinewiseOp(ctx, op, Math.min(line, targetLine), Math.max(line, targetLine));
	if (op !== "c") resetInput(ctx.state);
	return intents;
}

// ---------------------------------------------------------------------------
// Visual non-motion key handler
// ---------------------------------------------------------------------------

/**
 * Handle visual-specific keys. Returns an `EditIntent[]` when consumed, or
 * `null` when the key should fall through to the normal motion dispatch.
 */
function handleVisualKey(ctx: Ctx, data: string): EditIntent[] | null {
	// Let a mid-flight pendingG or charPending resolve normally (motions).
	// These were already checked before this function is called.

	const linewise = ctx.state.mode === "visual-line";

	const actionName = visualActionKeymap[data];
	if (actionName === undefined) return null;

	switch (actionName) {
		case "visual-v":
			if (linewise) return [{ kind: "setMode", mode: "visual" }];
			ctx.state.visualAnchor = null;
			return [{ kind: "setMode", mode: "normal" }];

		case "visual-V":
			if (linewise) {
				ctx.state.visualAnchor = null;
				return [{ kind: "setMode", mode: "normal" }];
			}
			return [{ kind: "setMode", mode: "visual-line" }];

		case "visual-d":
			return applyVisualOperator(ctx, "d", linewise);
		case "visual-c":
			return applyVisualOperator(ctx, "c", linewise);
		case "visual-D":
			return applyVisualOperator(ctx, "d", true);
		case "visual-C":
			return applyVisualOperator(ctx, "c", true);
		case "visual-y":
			return applyVisualOperator(ctx, "y", linewise);
		case "visual-Y":
			return applyVisualOperator(ctx, "y", true);

		case "visual-p": {
			// Visual paste: stash register, delete selection, restore, paste.
			const saved = ctx.state.registers.get();
			const deleteIntents = applyVisualOperator(ctx, "d", linewise);

			// Restore the original register (overwrite the one set by the delete).
			if (saved !== null) ctx.state.registers.set(saved);
			else ctx.state.registers.clear();

			// Compute post-delete cursor position analytically (buffer not yet modified).
			let postDeleteCursor: { line: number; col: number } | undefined;
			if (!linewise) {
				const { startAbs } = charwiseRange(ctx);
				postDeleteCursor = absToLineCol(ctx.host.getLines(), startAbs);
			} else {
				const { startLine, endLine } = linewiseRange(ctx);
				const lines = ctx.host.getLines();
				const last = lines.length - 1;
				const s = Math.max(0, Math.min(startLine, last));
				const e = Math.max(s, Math.min(endLine, last));
				if (e < last) {
					postDeleteCursor = { line: s, col: 0 };
				} else if (s > 0) {
					postDeleteCursor = { line: s - 1, col: (lines[s - 1] ?? "").length };
				} else {
					postDeleteCursor = { line: 0, col: 0 };
				}
			}
			const pasteIntents = actionPaste(ctx, 1, false, postDeleteCursor);
			return [...deleteIntents, ...pasteIntents];
		}

		case "visual-o":
			return swapEnds(ctx);

		case "visual-:":
			// Swallowed in visual mode (no ex yet).
			return [];

		default:
			return null;
	}
}

/** Apply an operator to the live visual selection. Returns EditIntent[]. */
function applyVisualOperator(
	ctx: Ctx,
	op: Operator,
	linewise: boolean,
): EditIntent[] {
	ctx.state.input.count = "";
	if (linewise) {
		const { startLine, endLine } = linewiseRange(ctx);
		ctx.state.visualAnchor = null;
		const modeIntent: EditIntent = { kind: "setMode", mode: op === "c" ? "insert" : "normal" };
		const opIntents = applyLinewiseOp(ctx, op, startLine, endLine);
		return [modeIntent, ...opIntents];
	}
	const { startAbs, endAbs } = charwiseRange(ctx);
	ctx.state.visualAnchor = null;
	if (op === "y") {
		// Visual charwise yank: capture span, park at start, keep buffer.
		const intents = yankCharwise(ctx, startAbs, endAbs);
		return [{ kind: "setMode", mode: "normal" }, ...intents];
	}
	const intents = deleteCharwise(ctx, startAbs, endAbs);
	return [{ kind: "setMode", mode: op === "c" ? "insert" : "normal" }, ...intents];
}

// ---------------------------------------------------------------------------
// Normal-key dispatch (no pending state)
// ---------------------------------------------------------------------------

function handleNormalKey(ctx: Ctx, data: string): EvaluateResult {
	const command = normalKeymap[data];
	if (command === undefined) return { intents: [], undoUnit: true }; // swallow unmapped key

	switch (command.type) {
		case "operator":
			ctx.state.input.operator = command.name;
			return { intents: [], undoUnit: false }; // incomplete: waiting for motion

		case "motion-gg":
			ctx.state.input.pendingG = true;
			return { intents: [], undoUnit: false }; // incomplete: waiting for second g

		case "motion-await-char":
			ctx.state.input.charPending = command.name;
			return { intents: [], undoUnit: false }; // incomplete: waiting for char

		case "motion-G": {
			const hasCount = ctx.state.input.count !== "";
			const n = takeCount(ctx.state);
			const m = motionG(ctx, n, hasCount);
			ctx.state.input.count = "";
			return { intents: [{ kind: "moveCursor", to: { line: m.targetLine, col: m.targetCol } }], undoUnit: true };
		}

		case "motion": {
			const count = takeCount(ctx.state);
			const fn = motionFns[command.name];
			if (fn === undefined) return { intents: [], undoUnit: true };
			const m = fn(ctx, count);
			if (m === null) { resetInput(ctx.state); return { intents: [], undoUnit: true }; }
			return { intents: [{ kind: "moveCursor", to: { line: m.targetLine, col: m.targetCol } }], undoUnit: true };
		}

		case "action":
			// `r` sets replacePending — incomplete command, no undo unit yet.
			if (command.name === "r") {
				ctx.state.input.replacePending = true;
				return { intents: [], undoUnit: false };
			}
			return { intents: dispatchNormalAction(ctx, command.name), undoUnit: true };

		case "textobject-intro":
			// Not valid in normal mode; swallow.
			return { intents: [], undoUnit: true };
	}
}

// ---------------------------------------------------------------------------
// Normal-key action dispatch
// ---------------------------------------------------------------------------

/** Dispatch a named normal-mode action. Called from handleNormalKey. */
function dispatchNormalAction(ctx: Ctx, name: string): EditIntent[] {
	switch (name) {
		case "i": return actionI(ctx);
		case "a": return actionA(ctx);
		case "I": return actionBigI(ctx);
		case "A": return actionBigA(ctx);
		case "o": return actionO(ctx);
		case "O": return actionBigO(ctx);
		case "v": return actionV(ctx);
		case "V": return actionBigV(ctx);
		case ";": return repeatCharFind(ctx, false);
		case ",": return repeatCharFind(ctx, true);
		case "x": return actionX(ctx, takeCount(ctx.state));
		case "s": return actionS(ctx, takeCount(ctx.state));
		case "D": return actionBigD(ctx);
		case "C": return actionBigC(ctx);
		case "Y": return actionBigY(ctx, takeCount(ctx.state));
		case "p": return actionPaste(ctx, takeCount(ctx.state), true);
		case "P": return actionPaste(ctx, takeCount(ctx.state), false);
		case ":": {
			ctx.state.exBuffer = ":";
			return [{ kind: "setExBuffer", value: ":" }];
		}
		// "u" is handled before handleNormalKey in evaluate; this branch is dead.
		default: return [];
	}
}

// ---------------------------------------------------------------------------
// Char-find repeat (;  ,)
// ---------------------------------------------------------------------------

function repeatCharFind(ctx: Ctx, reverse: boolean): EditIntent[] {
	const last = ctx.state.lastCharMotion;
	if (last === null) return [];
	const motion = reverse ? reverseCharMotion(last.motion) : last.motion;
	return applyCharFind(ctx, motion, last.char, takeCount(ctx.state), true);
}

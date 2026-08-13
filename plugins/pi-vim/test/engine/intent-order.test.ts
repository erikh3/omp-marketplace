/**
 * test/engine/intent-order.test.ts
 *
 * Asserts the ORDER and KINDS of EditIntents returned by `evaluate` for the
 * load-bearing sequences where effect ordering is observable (spec §6):
 *
 *   o       = setMode(insert) → replaceRange(EOL, \n)
 *   O       = setMode(insert) → replaceRange(BOL, \n) → moveCursor(line, 0)
 *   cw      = replaceRange(delete) → setMode(insert)
 *   s       = replaceRange(delete) → setMode(insert)
 *   paste   = replaceRange(insert) → moveCursor(back)
 *   INSERT  = forward intent, undoUnit: true
 *
 * These tests drive `evaluate` directly with a minimal fake Ctx so they stay
 * independent of the ModalVimEditor integration layer.
 */

import { describe, test, expect } from "bun:test";
import { evaluate } from "../../src/engine/dispatch.js";
import { makeVimState, resetInput } from "../../src/engine/state.js";
import type { Ctx } from "../../src/engine/state.js";
import type { HostEffects, VimMode } from "../../src/host/adapter.js";
import { RegisterFile } from "../../src/engine/registers.js";

// ---------------------------------------------------------------------------
// Fake host builder
// ---------------------------------------------------------------------------

function makeCtx(
	text: string,
	cursorLine: number,
	cursorCol: number,
	mode: VimMode = "normal",
): Ctx {
	const state = makeVimState();
	state.mode = mode;
	// Set register file fresh
	state.registers = new RegisterFile();

	const lines = text.split("\n");

	const host = {
		getLines: () => lines as readonly string[],
		getText: () => text,
		getCursor: () => ({ line: cursorLine, col: cursorCol }),
		// Write stubs — must not be called from evaluate in the new model
		moveCursor: (_to: unknown) => { throw new Error("moveCursor called imperatively"); },
		replaceRange: (_r: unknown, _t: unknown) => { throw new Error("replaceRange called imperatively"); },
		forward: (_d: unknown) => { throw new Error("forward called imperatively"); },
		signalMode: (_m: unknown) => { throw new Error("signalMode called imperatively"); },
		signalEx: (_b: unknown) => { throw new Error("signalEx called imperatively"); },
		runEx: (_l: unknown) => { throw new Error("runEx called imperatively"); },
		notify: (_m: unknown) => { throw new Error("notify called imperatively"); },
		getCommandNames: () => new Set<string>(),
		// undo/redo/history are still called directly (timeline ops)
		undo: (_n: number) => {},
		redo: (_n: number) => {},
		canRedo: () => false,
		clearHistory: () => {},
	} satisfies HostEffects;

	return { state, host };
}

// ---------------------------------------------------------------------------
// Helper: evaluate a sequence of keys and collect the last result
// ---------------------------------------------------------------------------

function evalKeys(ctx: Ctx, ...keys: string[]) {
	let last = { intents: [] as ReturnType<typeof evaluate>["intents"], undoUnit: false };
	for (const key of keys) {
		last = evaluate(ctx, key);
	}
	return last;
}

// ---------------------------------------------------------------------------
// o — open line below
// ---------------------------------------------------------------------------

describe("o — intent order: setMode(insert) then replaceRange(\\n) at EOL", () => {
	test("o on non-empty line emits [setMode, replaceRange] in that order", () => {
		const ctx = makeCtx("hello world", 0, 0);
		const { intents, undoUnit } = evalKeys(ctx, "o");
		expect(undoUnit).toBe(true);
		expect(intents).toHaveLength(2);
		expect(intents[0]).toMatchObject({ kind: "setMode", mode: "insert" });
		expect(intents[1]).toMatchObject({ kind: "replaceRange", text: "\n" });
		// replaceRange is at EOL (empty insert range)
		const eolAbs = "hello world".length;
		expect(intents[1]).toMatchObject({
			kind: "replaceRange",
			range: { start: eolAbs, end: eolAbs },
		});
	});
});

// ---------------------------------------------------------------------------
// O — open line above
// ---------------------------------------------------------------------------

describe("O — intent order: setMode(insert) → replaceRange(\\n at BOL) → moveCursor", () => {
	test("O emits [setMode, replaceRange, moveCursor] in that order", () => {
		const ctx = makeCtx("hello", 0, 3);
		const { intents, undoUnit } = evalKeys(ctx, "O");
		expect(undoUnit).toBe(true);
		expect(intents).toHaveLength(3);
		expect(intents[0]).toMatchObject({ kind: "setMode", mode: "insert" });
		expect(intents[1]).toMatchObject({ kind: "replaceRange", range: { start: 0, end: 0 }, text: "\n" });
		expect(intents[2]).toMatchObject({ kind: "moveCursor", to: { line: 0, col: 0 } });
	});
});

// ---------------------------------------------------------------------------
// cw — change word: delete → setMode insert
// ---------------------------------------------------------------------------

describe("cw — intent order: replaceRange(delete) → setMode(insert)", () => {
	test("cw on non-blank: [replaceRange delete, setMode insert]", () => {
		// "foo bar" cursor at 0 → cw acts like ce (non-blank): deletes "foo"
		const ctx = makeCtx("foo bar", 0, 0);
		// First 'c' sets operator pending, no intents
		const pending = evaluate(ctx, "c");
		expect(pending.intents).toHaveLength(0);
		expect(pending.undoUnit).toBe(false);
		// Second 'w' completes the change
		const { intents, undoUnit } = evaluate(ctx, "w");
		expect(undoUnit).toBe(true);
		// Must be delete first, then setMode
		expect(intents.length).toBeGreaterThanOrEqual(2);
		const deleteIdx = intents.findIndex((i) => i.kind === "replaceRange");
		const modeIdx = intents.findIndex((i) => i.kind === "setMode");
		expect(deleteIdx).toBeGreaterThanOrEqual(0);
		expect(modeIdx).toBeGreaterThan(deleteIdx);
		// setMode must be "insert"
		const modeIntent = intents[modeIdx];
		expect(modeIntent).toMatchObject({ kind: "setMode", mode: "insert" });
	});
});

// ---------------------------------------------------------------------------
// s — substitute: replaceRange → setMode insert
// ---------------------------------------------------------------------------

describe("s — intent order: replaceRange(delete) → setMode(insert)", () => {
	test("s on non-empty line: delete first, then enter insert", () => {
		const ctx = makeCtx("abc", 0, 1);
		const { intents, undoUnit } = evalKeys(ctx, "s");
		expect(undoUnit).toBe(true);
		// [replaceRange(""), setMode(insert)]
		expect(intents.length).toBeGreaterThanOrEqual(2);
		const deleteIdx = intents.findIndex((i) => i.kind === "replaceRange" && (i as {text: string}).text === "");
		const modeIdx = intents.findIndex((i) => i.kind === "setMode");
		expect(deleteIdx).toBe(0);
		expect(modeIdx).toBeGreaterThan(deleteIdx);
		expect(intents[modeIdx]).toMatchObject({ kind: "setMode", mode: "insert" });
	});
});

// ---------------------------------------------------------------------------
// p — charwise paste: replaceRange(insert) → moveCursor(back)
// ---------------------------------------------------------------------------

describe("p — intent order: replaceRange(insert) → moveCursor(back)", () => {
	test("p pastes register then steps cursor back to last char", () => {
		const ctx = makeCtx("abc", 0, 0);
		// Seed register with "xy"
		ctx.state.registers.set({ text: "xy", linewise: false });
		const { intents, undoUnit } = evalKeys(ctx, "p");
		expect(undoUnit).toBe(true);
		// [replaceRange (insert "xy"), moveCursor]
		expect(intents).toHaveLength(2);
		expect(intents[0]).toMatchObject({ kind: "replaceRange", text: "xy" });
		expect(intents[1]).toMatchObject({ kind: "moveCursor" });
		// Insert comes before moveCursor
		expect(intents.findIndex((i) => i.kind === "replaceRange"))
			.toBeLessThan(intents.findIndex((i) => i.kind === "moveCursor"));
		// moveCursor col = insertCol + text.length - lastWidth
		// cursor=0, onNonEmptyLine=true, after=true → insertAbs=1 (1 grapheme into "abc")
		// insertCol=1, textLen=2, lastWidth=1 → finalCol=2
		const movIntent = intents[1] as { kind: "moveCursor"; to: { line: number; col: number } };
		expect(movIntent.to).toMatchObject({ line: 0, col: 2 });
	});

	test("p with empty register returns no intents (zero undo units via no-op guard)", () => {
		const ctx = makeCtx("abc", 0, 0);
		// register is empty by default
		const { intents, undoUnit } = evalKeys(ctx, "p");
		// undoUnit can be true (history.commit no-ops if text unchanged) or false
		// We only check that no buffer-mutation intents are emitted
		const mutating = intents.filter(
			(i) => i.kind === "replaceRange" || i.kind === "moveCursor",
		);
		expect(mutating).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// INSERT forward
// ---------------------------------------------------------------------------

describe("INSERT forward — forward intent, undoUnit: true", () => {
	test("any key in INSERT mode returns forward intent with undoUnit: true", () => {
		const ctx = makeCtx("hello", 0, 3, "insert");
		const { intents, undoUnit } = evalKeys(ctx, "x");
		expect(undoUnit).toBe(true);
		expect(intents).toHaveLength(1);
		expect(intents[0]).toMatchObject({ kind: "forward", data: "x" });
	});

	test("Esc in INSERT is handled by handleInput before evaluate; not tested here", () => {
		// evaluate never sees Esc from INSERT (modal-editor.handleInput catches it first)
		// This is just a documentation test.
		expect(true).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// undoUnit: false for incomplete commands
// ---------------------------------------------------------------------------

describe("undoUnit: false for pending/incomplete commands", () => {
	test("operator 'd' sets pending and returns undoUnit: false", () => {
		const ctx = makeCtx("foo bar", 0, 0);
		const { intents, undoUnit } = evalKeys(ctx, "d");
		expect(undoUnit).toBe(false);
		expect(intents).toHaveLength(0);
	});

	test("digit accumulation returns undoUnit: false", () => {
		const ctx = makeCtx("foo bar", 0, 0);
		const { intents, undoUnit } = evalKeys(ctx, "3");
		expect(undoUnit).toBe(false);
		expect(intents).toHaveLength(0);
	});

	test("u (undo) returns undoUnit: false", () => {
		const ctx = makeCtx("foo", 0, 0);
		const { undoUnit } = evalKeys(ctx, "u");
		expect(undoUnit).toBe(false);
	});

	test("Ctrl+r (redo) returns undoUnit: false", () => {
		const ctx = makeCtx("foo", 0, 0);
		const { undoUnit } = evalKeys(ctx, "\x12"); // raw Ctrl+r
		expect(undoUnit).toBe(false);
	});
});

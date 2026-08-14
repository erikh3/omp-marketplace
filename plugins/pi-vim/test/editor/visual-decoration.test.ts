/**
 * test/editor/visual-decoration.test.ts
 *
 * Coverage for the visual-mode selection highlighting feature:
 *
 *   Pure layer (`src/engine/visual-decoration.ts`)
 *     - computeSelectionSpans — charwise / linewise span geometry, plus the
 *       "no selection" null exits.
 *     - advanceScan — forward layout-line scan cursor (the core of the
 *       decorateText position tracking).
 *     - applyLineSelection — background-escape injection around an overlap.
 *     - getSelectionColors — escape shape + memoization.
 *
 *   Integration layer (`ModalVimEditor.render` + the wrapped `decorateText`)
 *     - the selection background actually reaches the rendered output, is
 *       absent outside visual mode, clears on Esc, and leaves the flanks and
 *       the cursor glyph untouched.
 *
 * The integration cases drive a real editor (real base `CustomEditor`) through
 * `render(width)` with a render-capable theme stub — the feature only manifests
 * through the render pass, so a handful of end-to-end cases pin the wiring while
 * the pure layer carries the exhaustive behavior matrix.
 */

import { describe, expect, test } from "bun:test";
import type { EditorTheme } from "@oh-my-pi/pi-tui";
import type { VimMode, Pos } from "../../src/host/adapter.ts";
import type { Ctx } from "../../src/engine/state.ts";
import { makeVimState } from "../../src/engine/state.ts";
import {
	type LineSpan,
	type ScanCursor,
	computeSelectionSpans,
	makeScanCursor,
	advanceScan,
	applyLineSelection,
	getSelectionColors,
} from "../../src/engine/visual-decoration.ts";
import { ModalVimEditor } from "../../src/modal-editor.ts";
import { keys } from "../support/keys.ts";
import { parseState } from "../support/state.ts";

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

/** The reset escape the highlighter closes every background run with. */
const BG_RESET = "\x1b[49m";
/** Truecolor background escapes share this introducer. */
const BG_PREFIX = "\x1b[48";

/**
 * Build a minimal {@link Ctx} for the pure span computation: only `getLines`
 * and `getCursor` are read through the host, plus `state.mode`/`visualAnchor`.
 */
function ctxFor(
	lines: string[],
	anchor: Pos,
	cursor: Pos,
	mode: VimMode,
): Ctx {
	const state = makeVimState();
	state.mode = mode;
	state.visualAnchor = anchor;
	const host = {
		getLines: () => lines,
		getCursor: () => cursor,
	} as unknown as Ctx["host"];
	return { state, host };
}

// ---------------------------------------------------------------------------
// computeSelectionSpans
// ---------------------------------------------------------------------------

describe("computeSelectionSpans — not in visual mode", () => {
	test.each<VimMode>(["normal", "insert"])("mode %s → null", (mode) => {
		const ctx = ctxFor(["hello world"], { line: 0, col: 0 }, { line: 0, col: 4 }, mode);
		expect(computeSelectionSpans(ctx)).toBeNull();
	});
});

describe("computeSelectionSpans — charwise (visual)", () => {
	test("single line, anchor before cursor → inclusive column span", () => {
		// "hello world": anchor col 2, cursor col 5 (space). Inclusive end → col 6.
		const ctx = ctxFor(["hello world"], { line: 0, col: 2 }, { line: 0, col: 5 }, "visual");
		const spans = computeSelectionSpans(ctx);
		expect(spans).not.toBeNull();
		expect(spans!.get(0)).toEqual({ startCol: 2, endCol: 6 });
		expect(spans!.size).toBe(1);
	});

	test("reversed selection (cursor before anchor) → same ordered span", () => {
		const ctx = ctxFor(["hello world"], { line: 0, col: 5 }, { line: 0, col: 2 }, "visual");
		expect(computeSelectionSpans(ctx)!.get(0)).toEqual({ startCol: 2, endCol: 6 });
	});

	test("anchor == cursor → single-grapheme span", () => {
		const ctx = ctxFor(["abc"], { line: 0, col: 0 }, { line: 0, col: 0 }, "visual");
		expect(computeSelectionSpans(ctx)!.get(0)).toEqual({ startCol: 0, endCol: 1 });
	});

	test("multi-line selection → per-line column spans", () => {
		// "ab\ncd": anchor {0,1}, cursor {1,0}. Selection covers "b" on line 0 and
		// "c" on line 1.
		const ctx = ctxFor(["ab", "cd"], { line: 0, col: 1 }, { line: 1, col: 0 }, "visual");
		const spans = computeSelectionSpans(ctx)!;
		expect(spans.get(0)).toEqual({ startCol: 1, endCol: 2 });
		expect(spans.get(1)).toEqual({ startCol: 0, endCol: 1 });
		expect(spans.size).toBe(2);
	});

	test("selection to end of line includes the joining newline column", () => {
		// cursor sits at/past the end of line 0, so the range spills onto line 1.
		const ctx = ctxFor(["ab", "cd"], { line: 0, col: 0 }, { line: 0, col: 2 }, "visual");
		const spans = computeSelectionSpans(ctx)!;
		// Whole of line 0 selected; the trailing newline pushes a zero-width start
		// onto line 1, which is dropped (start == end).
		expect(spans.get(0)).toEqual({ startCol: 0, endCol: 2 });
		expect(spans.has(1)).toBe(false);
	});

	test("empty buffer in visual mode → null (empty range)", () => {
		const ctx = ctxFor([""], { line: 0, col: 0 }, { line: 0, col: 0 }, "visual");
		expect(computeSelectionSpans(ctx)).toBeNull();
	});
});

describe("computeSelectionSpans — linewise (visual-line)", () => {
	test("whole lines in range → full-width spans", () => {
		const ctx = ctxFor(["foo", "bar", "baz"], { line: 0, col: 0 }, { line: 1, col: 2 }, "visual-line");
		const spans = computeSelectionSpans(ctx)!;
		expect(spans.get(0)).toEqual({ startCol: 0, endCol: 3 });
		expect(spans.get(1)).toEqual({ startCol: 0, endCol: 3 });
		expect(spans.has(2)).toBe(false);
	});

	test("columns are ignored — reversed cursor still spans whole lines", () => {
		const ctx = ctxFor(["foo", "bar"], { line: 1, col: 2 }, { line: 0, col: 1 }, "visual-line");
		const spans = computeSelectionSpans(ctx)!;
		expect(spans.get(0)).toEqual({ startCol: 0, endCol: 3 });
		expect(spans.get(1)).toEqual({ startCol: 0, endCol: 3 });
	});

	test("empty line inside the range is skipped", () => {
		const ctx = ctxFor(["foo", "", "baz"], { line: 0, col: 0 }, { line: 2, col: 0 }, "visual-line");
		const spans = computeSelectionSpans(ctx)!;
		expect(spans.get(0)).toEqual({ startCol: 0, endCol: 3 });
		expect(spans.has(1)).toBe(false);
		expect(spans.get(2)).toEqual({ startCol: 0, endCol: 3 });
	});

	test("single empty line selected → null (no non-empty content)", () => {
		const ctx = ctxFor([""], { line: 0, col: 0 }, { line: 0, col: 0 }, "visual-line");
		expect(computeSelectionSpans(ctx)).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// advanceScan
// ---------------------------------------------------------------------------

describe("advanceScan", () => {
	test("empty text → returns current cursor, does not advance", () => {
		const cursor: ScanCursor = { lineIndex: 1, colOffset: 3 };
		expect(advanceScan(cursor, "", ["a", "bcd"])).toEqual({ lineIndex: 1, startCol: 3 });
		expect(cursor).toEqual({ lineIndex: 1, colOffset: 3 });
	});

	test("single segment at line start", () => {
		const cursor = makeScanCursor();
		expect(advanceScan(cursor, "hello", ["hello world"])).toEqual({ lineIndex: 0, startCol: 0 });
		expect(cursor).toEqual({ lineIndex: 0, colOffset: 5 });
	});

	test("second segment on same line locates via indexOf (skips inter-chunk gap)", () => {
		const lines = ["hello world"];
		const cursor: ScanCursor = { lineIndex: 0, colOffset: 5 };
		// "world" begins at col 6; the scan skips the space between chunks.
		expect(advanceScan(cursor, "world", lines)).toEqual({ lineIndex: 0, startCol: 6 });
		// Consuming to end of the logical line steps onto the next line.
		expect(cursor).toEqual({ lineIndex: 1, colOffset: 0 });
	});

	test("skips empty layout lines before matching", () => {
		const lines = ["", "text"];
		const cursor = makeScanCursor();
		expect(advanceScan(cursor, "text", lines)).toEqual({ lineIndex: 1, startCol: 0 });
	});

	test("consuming a full line steps to the next line", () => {
		const lines = ["ab", "cd"];
		const cursor = makeScanCursor();
		advanceScan(cursor, "ab", lines);
		expect(cursor).toEqual({ lineIndex: 1, colOffset: 0 });
	});

	test("segment not found in line → falls back to current offset", () => {
		const lines = ["abc"];
		const cursor: ScanCursor = { lineIndex: 0, colOffset: 1 };
		expect(advanceScan(cursor, "xyz", lines)).toEqual({ lineIndex: 0, startCol: 1 });
	});
});

// ---------------------------------------------------------------------------
// applyLineSelection
// ---------------------------------------------------------------------------

/** Expected highlighted string using the live selection colors. */
function highlight(text: string, relStart: number, relEnd: number): string {
	const { bg, reset } = getSelectionColors();
	return text.slice(0, relStart) + bg + text.slice(relStart, relEnd) + reset + text.slice(relEnd);
}

function spanMap(entries: [number, LineSpan][]): Map<number, LineSpan> {
	return new Map(entries);
}

describe("applyLineSelection — no-op exits (return null)", () => {
	test("empty text → null", () => {
		expect(applyLineSelection("", 0, 0, spanMap([[0, { startCol: 0, endCol: 3 }]]))).toBeNull();
	});

	test("no span for this line → null", () => {
		expect(applyLineSelection("abc", 0, 0, spanMap([[5, { startCol: 0, endCol: 3 }]]))).toBeNull();
	});

	test("span present but no overlap with segment → null", () => {
		expect(applyLineSelection("abc", 0, 0, spanMap([[0, { startCol: 5, endCol: 8 }]]))).toBeNull();
	});
});

describe("applyLineSelection — overlap injection", () => {
	test("full overlap wraps the whole segment", () => {
		const spans = spanMap([[0, { startCol: 0, endCol: 5 }]]);
		expect(applyLineSelection("hello", 0, 0, spans)).toBe(highlight("hello", 0, 5));
	});

	test("partial overlap at the start", () => {
		const spans = spanMap([[0, { startCol: 0, endCol: 2 }]]);
		expect(applyLineSelection("hello", 0, 0, spans)).toBe(highlight("hello", 0, 2));
	});

	test("partial overlap at the end", () => {
		const spans = spanMap([[0, { startCol: 3, endCol: 5 }]]);
		expect(applyLineSelection("hello", 0, 0, spans)).toBe(highlight("hello", 3, 5));
	});

	test("overlap in the middle", () => {
		const spans = spanMap([[0, { startCol: 1, endCol: 3 }]]);
		expect(applyLineSelection("hello", 0, 0, spans)).toBe(highlight("hello", 1, 3));
	});

	test("segment offset within the line is honored", () => {
		// "world" segment starts at absolute col 6; span cols [7,9) → "or".
		const spans = spanMap([[0, { startCol: 7, endCol: 9 }]]);
		expect(applyLineSelection("world", 0, 6, spans)).toBe(highlight("world", 1, 3));
	});

	test("span wider than the segment clamps to the segment bounds", () => {
		const spans = spanMap([[0, { startCol: 0, endCol: 100 }]]);
		expect(applyLineSelection("hi", 0, 0, spans)).toBe(highlight("hi", 0, 2));
	});
});

// ---------------------------------------------------------------------------
// getSelectionColors
// ---------------------------------------------------------------------------

describe("getSelectionColors", () => {
	test("reset is the background-only reset", () => {
		expect(getSelectionColors().reset).toBe(BG_RESET);
	});

	test("bg is a background escape (truecolor 48; or ANSI-16 fallback)", () => {
		const { bg } = getSelectionColors();
		expect(bg.startsWith(BG_PREFIX) || bg === "\x1b[44m").toBe(true);
	});

	test("bg is memoized — stable across calls", () => {
		expect(getSelectionColors().bg).toBe(getSelectionColors().bg);
	});
});

// ---------------------------------------------------------------------------
// Integration — ModalVimEditor.render + wrapped decorateText
// ---------------------------------------------------------------------------

/** Render-capable theme stub: only the fields the base render path reads. */
const renderTheme = {
	borderColor: (s: string) => s,
	editorPaddingX: 2,
	hintStyle: (t: string) => t,
	symbols: {
		inputCursor: "\u2588",
		boxRound: {
			topLeft: "\u256d",
			topRight: "\u256e",
			bottomLeft: "\u2570",
			bottomRight: "\u256f",
			horizontal: "\u2500",
			vertical: "\u2502",
		},
	},
	selectList: {},
} as unknown as EditorTheme;

interface RenderHarness {
	ed: ModalVimEditor;
	seed(marked: string): void;
	send(notation: string): void;
	out(width?: number): string;
}

function renderHarness(): RenderHarness {
	const ed = new ModalVimEditor(renderTheme);
	return {
		ed,
		seed(marked) {
			const { text, line, col } = parseState(marked);
			ed.setText(text);
			ed.moveToMessageStart();
			for (let i = 0; i < line; i++) ed.handleDraftEdit("\x1b[B");
			ed.moveToLineStart();
			for (let i = 0; i < col; i++) ed.handleDraftEdit("\x1b[C");
		},
		send(notation) {
			for (const chunk of keys(notation)) ed.handleInput(chunk);
		},
		out(width = 80) {
			return ed.render(width).join("\n");
		},
	};
}

/** Count non-overlapping occurrences of `needle` in `haystack`. */
function countOccurrences(haystack: string, needle: string): number {
	let count = 0;
	let from = 0;
	for (;;) {
		const idx = haystack.indexOf(needle, from);
		if (idx === -1) return count;
		count++;
		from = idx + needle.length;
	}
}

describe("render integration — no highlight outside visual mode", () => {
	test("insert mode → no background escape", () => {
		const h = renderHarness();
		h.seed("hello wor|ld");
		expect(h.out().includes(BG_PREFIX)).toBe(false);
	});

	test("normal mode → no background escape", () => {
		const h = renderHarness();
		h.seed("hello wor|ld");
		h.send("<Esc>");
		expect(h.out().includes(BG_PREFIX)).toBe(false);
	});
});

describe("render integration — charwise selection", () => {
	test("v + motion paints a background run that is properly closed", () => {
		const h = renderHarness();
		h.seed("|hello world");
		h.send("<Esc>vll"); // select cols 0..2 inclusive
		const out = h.out();
		expect(out.includes(BG_PREFIX)).toBe(true);
		expect(out.includes(BG_RESET)).toBe(true);
	});

	test("flank text after the selection is not inside the background run", () => {
		const h = renderHarness();
		h.seed("|hello world");
		h.send("<Esc>ve"); // select "hello"
		const out = h.out();
		// Everything after the closing reset should still contain the tail word,
		// proving the flank was emitted outside the highlight.
		const afterReset = out.slice(out.lastIndexOf(BG_RESET) + BG_RESET.length);
		expect(afterReset.includes("world")).toBe(true);
	});

	test("cursor glyph keeps its own reverse-video highlight (not the bg run)", () => {
		const h = renderHarness();
		h.seed("|hello world");
		h.send("<Esc>vll");
		// The base editor paints the cursor grapheme with reverse video (\x1b[7m),
		// independent of the selection background.
		expect(h.out().includes("\x1b[7m")).toBe(true);
	});
});

describe("render integration — linewise selection", () => {
	test("V paints the whole line background", () => {
		const h = renderHarness();
		h.seed("|hello world");
		h.send("<Esc>V");
		expect(h.out().includes(BG_PREFIX)).toBe(true);
	});

	test("multi-line V paints a background run on each selected row", () => {
		const h = renderHarness();
		h.seed("|foo\nbar\nbaz");
		h.send("<Esc>Vj"); // select lines 0 and 1
		expect(countOccurrences(h.out(), BG_PREFIX)).toBeGreaterThanOrEqual(2);
	});
});

describe("render integration — selection lifecycle", () => {
	test("leaving visual mode with Esc clears the highlight on the next render", () => {
		const h = renderHarness();
		h.seed("|hello world");
		h.send("<Esc>vll");
		expect(h.out().includes(BG_PREFIX)).toBe(true);
		h.send("<Esc>");
		expect(h.out().includes(BG_PREFIX)).toBe(false);
	});

	test("o (swap ends) keeps the selection highlighted", () => {
		const h = renderHarness();
		h.seed("|hello world");
		h.send("<Esc>vllo");
		expect(h.out().includes(BG_PREFIX)).toBe(true);
	});

	test("repeated renders are idempotent (scan cursor reset each pass)", () => {
		const h = renderHarness();
		h.seed("|hello world");
		h.send("<Esc>vll");
		expect(h.out()).toBe(h.out());
	});
});

describe("render integration — multi-line charwise scan", () => {
	test("selection spanning two logical lines paints both", () => {
		const h = renderHarness();
		h.seed("|hello\nworld");
		h.send("<Esc>vjl"); // extend down and right across the line break
		expect(countOccurrences(h.out(), BG_PREFIX)).toBeGreaterThanOrEqual(2);
	});
});

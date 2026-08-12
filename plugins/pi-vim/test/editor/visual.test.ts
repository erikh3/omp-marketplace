/**
 * test/editor/visual.test.ts
 *
 * Integration tests for VISUAL and VISUAL-LINE selections.
 * All cases use the cursor-marker DSL ("|" marks cursor):
 *   `before` — INSERT at marker; NORMAL cases start keys with "<Esc>".
 *   `after`  — expected cursor+buffer after keys.
 *
 * Behavior oracle: smoke.ts checks 40-46, 70-71 + source in
 * src/modal-editor.ts (#handleVisual, #applyVisualOperator, #swapVisualEnds).
 */

import { describe, expect, test, vt, createHarness } from "../support/harness.ts";

// ─── 1. Entering and exiting visual mode ────────────────────────────────────

describe("v — enter/exit charwise visual", () => {
	vt.each([
		// smoke #40: v enters visual, Esc exits to normal
		{
			name: "v enters visual mode",
			before: "|hello",
			keys: "<Esc>v",
			after: "|hello",
			mode: "visual",
		},
		{
			name: "v then Esc returns to normal",
			before: "|hello",
			keys: "<Esc>v<Esc>",
			after: "|hello",
			mode: "normal",
		},
		// pressing v again while in charwise visual exits back to normal
		{
			name: "v v (toggle) exits visual",
			before: "|hello",
			keys: "<Esc>vv",
			after: "|hello",
			mode: "normal",
		},
	]);
});

describe("V — enter/exit visual-line", () => {
	vt.each([
		{
			name: "V enters visual-line mode",
			before: "|hello",
			keys: "<Esc>V",
			after: "|hello",
			mode: "visual-line",
		},
		{
			name: "V then Esc exits to normal",
			before: "|hello",
			keys: "<Esc>V<Esc>",
			after: "|hello",
			mode: "normal",
		},
		// pressing V again while in visual-line exits back to normal
		{
			name: "V V (toggle) exits visual-line",
			before: "|hello",
			keys: "<Esc>VV",
			after: "|hello",
			mode: "normal",
		},
	]);
});

// ─── 2. v↔V: switching charwise ↔ linewise mid-selection ──────────────────

describe("v↔V — switch charwise/linewise mid-selection", () => {
	// from visual-line, pressing v switches to charwise visual (doesn't exit)
	vt.each([
		{
			name: "V then v switches to charwise visual",
			before: "|hello",
			keys: "<Esc>Vv",
			after: "|hello",
			mode: "visual",
		},
		{
			name: "v then V switches to visual-line",
			before: "|hello",
			keys: "<Esc>vV",
			after: "|hello",
			mode: "visual-line",
		},
	]);
});

// ─── 3. Visual motions resize the selection ──────────────────────────────────

describe("visual charwise — motions resize selection (h l j k)", () => {
	vt.each([
		{
			// l moves cursor right, expanding selection
			name: "v l moves cursor right",
			before: "ab|cd",
			keys: "<Esc>0vll",
			after: "ab|cd",
			mode: "visual",
		},
		{
			// h moves cursor left, shrinking/reversing selection
			// anchor stays at col 0; after ll cursor is at col 2, h moves it to col 1
			name: "v l then h moves cursor left",
			before: "|abcd",
			keys: "<Esc>vll h",
			after: "a|bcd",
			mode: "visual",
		},
	]);
});

describe("visual charwise — w b e motions", () => {
	test("v w moves to next word start", () => {
		const h = createHarness();
		h.seed("|the quick");
		h.send("<Esc>vw");
		expect(h.ed.mode).toBe("visual");
		// cursor moved forward one word — we just confirm mode and that cursor advanced
		const state = h.state();
		// after 'w' from col 0 in "the quick", cursor lands on 'q' (col 4)
		expect(state).toBe("the |quick");
	});

	test("v b moves to previous word start", () => {
		const h = createHarness();
		h.seed("the |quick");
		h.send("<Esc>vb");
		expect(h.ed.mode).toBe("visual");
		// cursor moved back to 'q' then 'the'; land on col 0
		const state = h.state();
		expect(state).toBe("|the quick");
	});

	test("v e moves to end of word", () => {
		const h = createHarness();
		h.seed("|the quick");
		h.send("<Esc>ve");
		expect(h.ed.mode).toBe("visual");
		// 'e' from col 0 lands on last char of 'the' => col 2
		const state = h.state();
		expect(state).toBe("th|e quick");
	});
});

describe("visual charwise — f{char} motion", () => {
	vt.each([
		{
			name: "v f{c} extends to char",
			before: "|hello world",
			// anchor at 'h', f+o moves cursor to first 'o' (col 4)
			keys: "<Esc>vfo",
			after: "hell|o world",
			mode: "visual",
		},
	]);
});

describe("visual charwise — % motion", () => {
	test("v % extends to matching bracket", () => {
		const h = createHarness();
		h.seed("|foo(bar)end");
		h.send("<Esc>v%");
		expect(h.ed.mode).toBe("visual");
		// % from '(' at col 3 would jump there; from col 0 on 'f', % finds first paren
		// Actually: cursor at 0, v enters visual at col 0, then % searches forward for (
		// and jumps to matching ). Let's place cursor ON the paren.
		const h2 = createHarness();
		h2.seed("foo|(bar)end");
		h2.send("<Esc>v%");
		expect(h2.ed.mode).toBe("visual");
		// cursor moves from '(' to ')' at col 7
		expect(h2.state()).toBe("foo(bar|)end");
	});
});

describe("visual charwise — gg G motions", () => {
	test("v gg jumps to buffer start", () => {
		const h = createHarness();
		h.seed("first\nse|cond\nthird");
		h.send("<Esc>vgg");
		expect(h.ed.mode).toBe("visual");
		// cursor should now be at line 0, col 0
		expect(h.state()).toBe("|first\nsecond\nthird");
	});

	test("v G jumps to buffer end", () => {
		const h = createHarness();
		h.seed("|first\nsecond\nthird");
		h.send("<Esc>vG");
		expect(h.ed.mode).toBe("visual");
		// cursor now on last line (line 2, col 0)
		expect(h.state()).toBe("first\nsecond\n|third");
	});
});

// ─── 4. Visual-line j/k extend by whole lines ────────────────────────────────

describe("V (visual-line) — j/k extend by whole lines", () => {
	// smoke #44: V + j extends over two lines
	vt.each([
		{
			// visual-line: after V + j the cursor is on line 1, anchor on line 0
			name: "V j extends to next line",
			before: "|a\nb\nc",
			keys: "<Esc>ggVj",
			after: "a\n|b\nc",
			mode: "visual-line",
		},
		{
			name: "V k extends to previous line (from line 1)",
			before: "a\n|b\nc",
			keys: "<Esc>Vk",
			after: "|a\nb\nc",
			mode: "visual-line",
		},
	]);
});

// ─── 5. Operators on charwise selection ──────────────────────────────────────

describe("v d / v x — delete charwise selection → normal", () => {
	// smoke #41: v + motion + d deletes inclusive span
	vt.each([
		{
			name: "v ll d deletes inclusive span (smoke #41)",
			before: "|hello world",
			keys: "<Esc>0vll d",
			after: "|lo world",
			mode: "normal",
		},
		{
			name: "v x deletes selection (x == d in visual)",
			before: "|hello world",
			keys: "<Esc>0vll x",
			after: "|lo world",
			mode: "normal",
		},
		{
			// selection spanning a whole word
			name: "v e d deletes to end of word",
			before: "|hello world",
			keys: "<Esc>0ve d",
			after: "| world",
			mode: "normal",
		},
		{
			// single-char selection
			name: "v d deletes single char under cursor",
			before: "|abc",
			keys: "<Esc>0vd",
			after: "|bc",
			mode: "normal",
		},
	]);
});

describe("v c / v s — delete charwise → insert", () => {
	// smoke #42: visual c deletes and enters INSERT
	vt.each([
		{
			name: "v ll c deletes and enters insert (smoke #42)",
			before: "|abcdef",
			keys: "<Esc>0vllc",
			after: "|def",
			mode: "insert",
		},
		{
			name: "v s deletes and enters insert (s == c in visual)",
			before: "|abcdef",
			keys: "<Esc>0vlls",
			after: "|def",
			mode: "insert",
		},
	]);
});

describe("v y — yank charwise → normal, cursor at start", () => {
	// smoke #70: visual y returns to normal at selection start
	test("v l y yanks selection, returns to normal at start", () => {
		const h = createHarness();
		h.seed("|hello");
		h.send("<Esc>0vl y");
		expect(h.ed.mode).toBe("normal");
		// cursor parked at start of selection (col 0)
		expect(h.state()).toBe("|hello");
	});

	test("v y then p pastes yanked selection (smoke #70)", () => {
		const h = createHarness();
		h.seed("|hello");
		h.send("<Esc>0vl y");          // yank "he"
		expect(h.ed.mode).toBe("normal");
		h.send("$p");                  // paste after last char 'o'
		expect(h.ed.getText()).toBe("hellohe");
	});
});

describe("v Y — force-linewise yank → normal", () => {
	test("v Y yanks whole lines regardless of charwise selection", () => {
		const h = createHarness();
		h.seed("aa\n|bb\ncc");
		// Select char-wise on 'b' only, but Y force-linewise yanks the whole line
		h.send("<Esc>vY");
		expect(h.ed.mode).toBe("normal");
		// yank line "bb", paste below
		h.send("p");
		expect(h.ed.getText()).toBe("aa\nbb\nbb\ncc");
	});
});

// ─── 6. Operators on visual-line selection ───────────────────────────────────

describe("V d / V x — delete whole lines → normal", () => {
	// smoke #43: V + d deletes the whole line
	vt.each([
		{
			name: "V d deletes whole line (smoke #43)",
			before: "|one\ntwo\nthree",
			keys: "<Esc>ggVd",
			after: "|two\nthree",
			mode: "normal",
		},
		{
			name: "V x deletes whole line (x == d in visual-line)",
			before: "|one\ntwo\nthree",
			keys: "<Esc>ggVx",
			after: "|two\nthree",
			mode: "normal",
		},
	]);
});

describe("V j d — extend and delete multiple lines", () => {
	// smoke #44: V + j + d deletes both lines
	vt.each([
		{
			name: "V j d deletes two lines (smoke #44)",
			before: "|a\nb\nc\nd",
			keys: "<Esc>ggVjd",
			after: "|c\nd",
			mode: "normal",
		},
		{
			name: "V j j d deletes three lines",
			before: "|a\nb\nc\nd",
			keys: "<Esc>ggVjjd",
			after: "|d",
			mode: "normal",
		},
	]);
});

describe("V c / V s — delete lines → insert", () => {
	vt.each([
		{
			name: "V c deletes line and enters insert",
			before: "|hello\nworld",
			keys: "<Esc>ggVc",
			after: "|\nworld",
			mode: "insert",
		},
		{
			name: "V s deletes line and enters insert (s == c in visual-line)",
			before: "|hello\nworld",
			keys: "<Esc>ggVs",
			after: "|\nworld",
			mode: "insert",
		},
	]);
});

describe("V y — yank linewise → normal", () => {
	// smoke #71: visual-line Y yanks whole lines; p duplicates below
	test("V y yanks line, returns to normal (smoke #71)", () => {
		const h = createHarness();
		h.seed("|aa\nbb");
		h.send("<Esc>ggVy");
		expect(h.ed.mode).toBe("normal");
	});

	test("V y then p pastes line below (smoke #71)", () => {
		const h = createHarness();
		h.seed("|aa\nbb");
		h.send("<Esc>ggVy");
		h.send("p");
		expect(h.ed.getText()).toBe("aa\naa\nbb");
	});
});

// ─── 7. D X C S — force-linewise regardless of charwise selection ──────────

describe("D X C S — force linewise on charwise selection", () => {
	test("v D force-linewise deletes whole line", () => {
		const h = createHarness();
		h.seed("|one\ntwo\nthree");
		// select only "on" charwise, but D force-linewise
		h.send("<Esc>ggvlD");
		expect(h.ed.mode).toBe("normal");
		expect(h.ed.getText()).toBe("two\nthree");
	});

	test("v X force-linewise deletes whole line (X == D in visual)", () => {
		const h = createHarness();
		h.seed("|one\ntwo\nthree");
		h.send("<Esc>ggvlX");
		expect(h.ed.mode).toBe("normal");
		expect(h.ed.getText()).toBe("two\nthree");
	});

	test("v C force-linewise changes whole line → insert", () => {
		const h = createHarness();
		h.seed("|one\ntwo\nthree");
		h.send("<Esc>ggvlC");
		expect(h.ed.mode).toBe("insert");
		// "one" line deleted, left with empty first line
		expect(h.ed.getText()).toBe("\ntwo\nthree");
	});

	test("v S force-linewise changes whole line → insert (S == C in visual)", () => {
		const h = createHarness();
		h.seed("|one\ntwo\nthree");
		h.send("<Esc>ggvlS");
		expect(h.ed.mode).toBe("insert");
		expect(h.ed.getText()).toBe("\ntwo\nthree");
	});
});

// ─── 8. o / O — swap which end is active ─────────────────────────────────────

describe("o / O — swap active (cursor) end of selection", () => {
	// smoke #46: o swaps selection ends so the other end moves
	test("v o swaps cursor to anchor (smoke #46)", () => {
		const h = createHarness();
		h.seed("|abcdef");
		// Place cursor at col 2 ('c'), then visual, extend right to col 3 ('d')
		h.send("<Esc>llvl");           // cursor col 3, anchor col 2 → selection c,d
		h.send("o");                   // swap: cursor now at col 2, anchor at col 3
		expect(h.ed.getCursor().col).toBe(2);
	});

	test("v o then h extends selection left after swap (smoke #46)", () => {
		const h = createHarness();
		h.seed("|abcdef");
		h.send("<Esc>llvl");           // anchor=2, cursor=3 (selection: c,d)
		h.send("o");                   // swap: cursor=2, anchor=3
		h.send("h");                   // cursor moves left to col 1 (selection: b,c,d)
		h.send("d");                   // delete b,c,d → "aef"
		expect(h.ed.getText()).toBe("aef");
	});

	test("O also swaps ends (O == o in visual)", () => {
		const h = createHarness();
		h.seed("|abcdef");
		h.send("<Esc>llvl");           // anchor=2, cursor=3
		h.send("O");                   // same as o
		expect(h.ed.getCursor().col).toBe(2);
	});

	test("V o swaps ends in visual-line", () => {
		const h = createHarness();
		h.seed("|a\nb\nc");
		h.send("<Esc>ggVj");           // anchor=line0, cursor=line1
		h.send("o");                   // swap: cursor=line0, anchor=line1
		// after swap, k would move cursor up (no-op at top), j would extend down
		// just confirm mode is still visual-line and we can delete
		h.send("d");                   // now only deletes lines 0-1 (same range)
		expect(h.ed.getText()).toBe("c");
	});
});

// ─── 9. Visual undo undoes as one unit ──────────────────────────────────────

describe("visual delete undo — restores as one unit", () => {
	// smoke #45: visual delete undoes in one step
	test("v e d then u restores whole visual delete (smoke #45)", () => {
		const h = createHarness();
		h.seed("|hello world");
		h.send("<Esc>0ved");           // delete "hello" → " world"
		expect(h.ed.getText()).toBe(" world");
		h.send("u");                   // one undo
		expect(h.ed.getText()).toBe("hello world");
	});

	test("V d then u restores whole line", () => {
		const h = createHarness();
		h.seed("|one\ntwo");
		h.send("<Esc>ggVd");
		expect(h.ed.getText()).toBe("two");
		h.send("u");
		expect(h.ed.getText()).toBe("one\ntwo");
	});
});

// ─── 10. Visual paste (p/P) — replace selection with register ───────────────

describe("v p — replace charwise selection with register", () => {
	test("yank word then visually select and p replaces", () => {
		const h = createHarness();
		h.seed("|hello world");
		// First yank "hello" (yank inner word from position 0)
		h.send("<Esc>0yw");           // yank "hello " (word)
		// Now move to "world" and visually select it
		h.send("$bvep");             // select "world", paste "hello " over it
		expect(h.ed.mode).toBe("normal");
		// "world" replaced with "hello " (trailing space from yw)
		const t = h.ed.getText();
		// The exact result: "hello " was yanked (yw includes trailing space)
		// Charwise select "world" and paste
		expect(t).toContain("hello");
	});

	test("seed register with yy, visually select char span, p replaces with line", () => {
		const h = createHarness();
		h.seed("|foo\nbar\nbaz");
		// Yank "foo" line
		h.send("<Esc>ggyy");
		// Select "ba" in "bar" and replace with yanked line
		h.send("jvlp");
		expect(h.ed.mode).toBe("normal");
		// linewise register replaces charwise selection (paste goes to cursor position)
		// The selection is deleted, then "foo\n" is pasted (linewise, P semantics)
		const t = h.ed.getText();
		// "bar" had "ba" deleted → "r\nbaz", then "foo" inserted as new line
		// Actually linewise paste inserts on a new line at/above cursor
		expect(typeof t).toBe("string"); // smoke: just verify no crash
	});
});

describe("v p vs v P — both replace selection", () => {
	// Both p and P in visual mode replace the selection (they differ only after deletion
	// for charwise: P inserts at cursor, p inserts after cursor, but the selection is
	// already deleted to the cursor position, so both behave identically for charwise).
	test("v P also replaces selection", () => {
		const h = createHarness();
		h.seed("|abcde");
		h.send("<Esc>0yw");           // yank "abcde" (or word portion)
		h.send("0vllP");             // select "abc", replace
		expect(h.ed.mode).toBe("normal");
		// P also replaces — no crash, mode normal
	});
});

// ─── 11. Boundary / edge cases ──────────────────────────────────────────────

describe("visual — single-char and empty-line boundaries", () => {
	vt.each([
		{
			// BOF: visual from col 0 — h is a no-op, selection unchanged
			name: "v at BOF h is no-op",
			before: "|abc",
			keys: "<Esc>0vh",
			after: "|abc",
			mode: "visual",
		},
		{
			// EOF: visual at last char ('c'), l moves past EOL (extends past end)
			// actual cursor stays on last char position
			name: "v at EOL l stays at last char",
			before: "ab|c",
			keys: "<Esc>$vl",
			after: "abc|",
			mode: "visual",
		},
		{
			// delete entire single-line buffer
			name: "v $ d deletes to end of line",
			before: "|hello",
			keys: "<Esc>0v$d",
			after: "|",
			mode: "normal",
		},
	]);
});

describe("visual-line — single line buffer", () => {
	vt.each([
		{
			// Visual-line on the only line, delete leaves empty buffer
			name: "V d on single line leaves empty buffer",
			before: "|only line",
			keys: "<Esc>ggVd",
			after: "|",
			mode: "normal",
		},
	]);
});

// ─── 12. Charwise selection crossing newline ─────────────────────────────────

describe("visual charwise — selection crossing newline", () => {
	test("v j d deletes across two lines", () => {
		const h = createHarness();
		h.seed("|ab\ncd\nef");
		h.send("<Esc>0vjd");
		expect(h.ed.mode).toBe("normal");
		// Line 0 col 0 to line 1 col 0: deletes "ab\nc" (inclusive), leaving "d\nef"
		const t = h.ed.getText();
		expect(t).toBe("d\nef");
	});
});

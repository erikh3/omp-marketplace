/**
 * Yank / paste via the unnamed register — behavioral assertions only.
 *
 * The register has no public getter; its contents are always observed by
 * pasting and inspecting the resulting buffer+cursor, exactly as vim semantics
 * require and smoke.ts checks 62–73 do.
 *
 * Convention: `before` seeds the editor in INSERT at the marked cursor.
 * NORMAL-mode operations start `keys` with `<Esc>`.
 */

import { describe, expect, test, vt, createHarness } from "../support/harness.ts";

// ---------------------------------------------------------------------------
// yw / yiw — charwise word yank
// ---------------------------------------------------------------------------

describe("yw — yank word, p pastes charwise after cursor", () => {
	vt.each([
		{
			// Smoke 62: yw yanks "foo " (word + trailing space), p pastes after last char.
			name: "yw then p appends yanked word",
			before: "|foo bar",
			keys: "<Esc>yw$p",
			// text: "foo barfoo "; cursor on the last pasted grapheme (space at col 10)
			after: "foo barfoo| ",
			mode: "normal",
		},
		{
			// yw on a standalone word (no trailing space) yanks to end of buffer;
			// p appends the word after the last char.
			name: "yw on last word (no trailing space), p appends at end",
			before: "|two",
			keys: "<Esc>yw$p",
			// yw from col 0 in single-word "two": w target = cur.length = 3, yank "two".
			// $ → col 2 ('o'). p after 'o': insertAbs=3, insert "two", cursor=3+3-1=5.
			after: "twotw|o",
			mode: "normal",
		},
	]);
});

describe("yiw — yank inner word, P pastes charwise before cursor", () => {
	vt.each([
		{
			// Smoke 63: yiw at col 0 yanks "alpha" (no surrounding space), P pastes before cursor.
			// After P: text = "alphaalpha beta"; cursor on last pasted char (col 4 = 'a').
			name: "yiw then P prepends yanked inner word",
			before: "|alpha beta",
			keys: "<Esc>yiwP",
			after: "alph|aalpha beta",
			mode: "normal",
		},
		{
			// yiw on the second word: navigate there with w before yiw.
			// ESC at col 0 (no backup), w → col 6 ('w' of "world"), yiw yanks "world".
			name: "w + yiw then P inserts inner word before selection start",
			before: "|hello world",
			keys: "<Esc>wyiwP",
			// yiw yanks "world", cursor at col 6. P pastes "world" before col 6:
			// text = "hello worldworld"; insertAbs=6, cursor=6+5-1=10.
			after: "hello worl|dworld",
			mode: "normal",
		},
	]);
});

// ---------------------------------------------------------------------------
// yy — yank line (linewise), p/P paste on new line
// ---------------------------------------------------------------------------

describe("yy then p — linewise paste below", () => {
	vt.each([
		{
			// Smoke 64: yy on line 0 "one", p duplicates below; cursor on new pasted line.
			name: "yy then p duplicates line below",
			before: "|one\ntwo",
			keys: "<Esc>yyp",
			// text: "one\none\ntwo"; linewise paste lands cursor on line 1 first non-blank
			after: "one\n|one\ntwo",
			mode: "normal",
		},
		{
			// yy on the last line, p appends after
			name: "yy on last line, p appends a duplicate below",
			before: "foo\n|bar",
			keys: "<Esc>yyp",
			after: "foo\nbar\n|bar",
			mode: "normal",
		},
	]);
});

describe("yy then P — linewise paste above", () => {
	vt.each([
		{
			// Smoke 65: yy on line 0 "one", P pastes above; cursor stays on what was line 0.
			name: "yy then P duplicates line above",
			before: "|one\ntwo",
			keys: "<Esc>yyP",
			// text: "one\none\ntwo"; linewise P: insert above, then gotoLine(originalLine=0)
			// After inserting "one\n" before line 0, result is "one\none\ntwo"; cursor on line 0.
			after: "|one\none\ntwo",
			mode: "normal",
		},
		{
			// P on a middle line pastes above that line
			name: "yy then P on middle line inserts above",
			before: "aaa\n|bbb\nccc",
			keys: "<Esc>yyP",
			// yy yanks "bbb\n"; P inserts above line 1 → "aaa\nbbb\nbbb\nccc"; cursor on line 1
			after: "aaa\n|bbb\nbbb\nccc",
			mode: "normal",
		},
	]);
});

// ---------------------------------------------------------------------------
// Linewise paste cursor rest position (smoke 69)
// ---------------------------------------------------------------------------

describe("linewise paste — cursor rests on first non-blank of pasted line", () => {
	vt.each([
		{
			// Smoke 69: yy on line 0, j to line 1, p pastes below line 1; cursor on pasted line (line 2).
			name: "yy + j + p: cursor on newly pasted line",
			before: "|one\ntwo",
			keys: "<Esc>yyjp",
			// text: "one\ntwo\none"; cursor on line 2 (pasted)
			after: "one\ntwo\n|one",
			mode: "normal",
		},
		{
			// First non-blank: indented line
			name: "linewise paste of indented line lands cursor on first non-blank",
			before: "|  hello\nworld",
			keys: "<Esc>yyp",
			// yy yanks "  hello\n"; p pastes below → "  hello\n  hello\nworld"; cursor on line 1 col 2
			after: "  hello\n  |hello\nworld",
			mode: "normal",
		},
	]);
});

// ---------------------------------------------------------------------------
// dd then p — delete fills the register; p pastes the deleted line below
// ---------------------------------------------------------------------------

describe("dd then p — deleted line pastes below current line", () => {
	vt.each([
		{
			// Smoke 66: dd on line 0 "a" removes it; p pastes "a" below the new line 0 "b".
			name: "dd then p pastes deleted line below",
			before: "|a\nb\nc",
			keys: "<Esc>ggddp",
			// After dd: "b\nc", cursor on "b" (line 0). p → "b\na\nc"; cursor on line 1.
			after: "b\n|a\nc",
			mode: "normal",
		},
		{
			// Delete last line then p re-inserts it below (which ends up appending)
			name: "dd on last line then p re-appends below",
			before: "x\n|y",
			keys: "<Esc>ddp",
			// dd removes "y" → "x", cursor on line 0 "x". p pastes "y\n" below → "x\ny".
			after: "x\n|y",
			mode: "normal",
		},
	]);
});

// ---------------------------------------------------------------------------
// x then p — charwise transpose
// ---------------------------------------------------------------------------

describe("x then p — charwise delete/paste transposes characters", () => {
	vt.each([
		{
			// Smoke 67: x deletes 'a', p pastes it after 'b' → "ba".
			name: "x then p transposes adjacent characters",
			before: "|ab",
			keys: "<Esc>xp",
			// text: "ba"; paste 'a' after 'b': insertAbs=1, insert 'a', cursor = 1+1-1 = 1 = col 1
			after: "b|a",
			mode: "normal",
		},
		{
			// x on a char with a successor: x deletes it; p moves it one step right.
			// ESC from col 2 backs up to col 1 ('b'). x deletes 'b' → "ac", cursor on 'c'.
			// p pastes 'b' after 'c' → "acb", cursor on 'b' at col 2.
			name: "x mid-word then p moves char one step right",
			before: "ab|c",
			keys: "<Esc>xp",
			after: "ac|b",
			mode: "normal",
		},
	]);
});

// ---------------------------------------------------------------------------
// {count}p — paste register N times
// ---------------------------------------------------------------------------

describe("{count}p — paste register multiple times", () => {
	vt.each([
		{
			// Smoke 68: x yanks 'x', 3p pastes "x" three times → "yxxx".
			name: "3p pastes charwise register three times",
			before: "|xy",
			keys: "<Esc>x3p",
			// text: "yxxx"; cursor on last 'x' (col 3)
			after: "yxx|x",
			mode: "normal",
		},
		{
			// 2p with a word yank
			name: "2p duplicates a yanked word twice",
			before: "|ab",
			keys: "<Esc>yw$2p",
			// yw yanks "ab" (no trailing space — 'ab' ends the line). Wait: "ab" is at end,
			// yw from col 0: word motion reaches col 2 (end of buffer) → yank "ab" (2 chars).
			// Actually 'w' moves forward to next word start; at end-of-line it may stop at 2.
			// After $: col 1 (last char 'b'). 2p pastes "ab" twice after 'b':
			// insertAbs = 2, insert "abab" (4), cursor = 2+4-1 = 5. text = "ababab".
			after: "ababa|b",
			mode: "normal",
		},
		{
			// 1p is identical to p
			name: "1p is the same as p",
			before: "|cd",
			keys: "<Esc>yw$1p",
			// yw yanks "cd", $ → col 1, 1p pastes "cd" once after 'd':
			// insertAbs = 2, insert "cd", cursor = 2+2-1 = 3. text = "cdcd".
			after: "cdc|d",
			mode: "normal",
		},
	]);
});

// ---------------------------------------------------------------------------
// Empty register — p is a no-op
// ---------------------------------------------------------------------------

describe("p with empty register — no-op", () => {
	vt.each([
		{
			// Smoke 73: nothing yanked, p does nothing.
			name: "p on empty register leaves buffer unchanged",
			before: "|abc",
			keys: "<Esc>0p",
			after: "|abc",
			mode: "normal",
		},
		{
			// P also no-ops with empty register. ESC from col 0 stays col 0; P no-ops.
			name: "P on empty register leaves buffer unchanged",
			before: "|xyz",
			keys: "<Esc>P",
			after: "|xyz",
			mode: "normal",
		},
	]);
});

// ---------------------------------------------------------------------------
// Visual charwise y then p
// ---------------------------------------------------------------------------

describe("visual charwise y — yank selection, p pastes charwise", () => {
	vt.each([
		{
			// Smoke 70: v enters VISUAL, l extends to "he", y yanks + returns NORMAL at start,
			// $ → last char 'o', p pastes "he" after 'o' → "hellohe"; cursor on 'e' at col 6.
			name: "visual charwise y then p pastes selection",
			before: "|hello",
			keys: "<Esc>vly$p",
			after: "helloh|e",
			mode: "normal",
		},
		{
			// Visual y returns to NORMAL without modifying the buffer.
			name: "visual charwise y returns to NORMAL at selection start",
			before: "|foo bar",
			keys: "<Esc>vllly",
			// v + lll selects "foo", y yanks and returns cursor to col 0
			after: "|foo bar",
			mode: "normal",
		},
	]);
});

// ---------------------------------------------------------------------------
// Visual-line Y then p
// ---------------------------------------------------------------------------

describe("visual-line Y — yank whole lines, p duplicates below", () => {
	vt.each([
		{
			// Smoke 71: V enters visual-line on line 0, y yanks "aa\n" linewise,
			// returns to NORMAL; p pastes below line 0 → "aa\naa\nbb"; cursor on line 1.
			name: "visual-line y then p duplicates line below",
			before: "|aa\nbb",
			keys: "<Esc>Vyp",
			after: "aa\n|aa\nbb",
			mode: "normal",
		},
		{
			// Visual-line y returns to NORMAL
			name: "visual-line y returns to NORMAL after yank",
			before: "|aa\nbb",
			keys: "<Esc>Vy",
			after: "|aa\nbb",
			mode: "normal",
		},
		{
			// Visual-line over two lines (V + j) yanks both; p duplicates both below
			name: "visual-line over two lines then p duplicates both below",
			before: "|one\ntwo\nthree",
			keys: "<Esc>Vjyp",
			// V on line 0, j extends to line 1 (visual-line "one\ntwo"), y yanks.
			// Returns to NORMAL at line 0. p pastes "one\ntwo" below line 0:
			// "one\none\ntwo\ntwo\nthree"? Actually gotoLine(line+1) where line=0, so cursor on line 1.
			// Wait — `block = "one\ntwo"` (content without trailing \n after slice).
			// insertText(`\n${block}`) = "\none\ntwo" appended after line 0.
			// Result: "one\none\ntwo\ntwo\nthree"; cursor on line 1.
			after: "one\n|one\ntwo\ntwo\nthree",
			mode: "normal",
		},
	]);
});

// ---------------------------------------------------------------------------
// Smoke 72 — yank does not disturb undo of a subsequent real edit
// ---------------------------------------------------------------------------

describe("yank does not disturb a later undo of a real edit", () => {
	test("yank, then real edit, then u reverts only the edit (smoke 72)", () => {
		const h = createHarness();
		// Seed "word" with cursor at col 0 in INSERT, then go to NORMAL
		h.seed("|word");
		h.send("<Esc>"); // NORMAL at col 0

		// Pure yank — no buffer mutation, so the undo timeline is untouched
		h.send("yw"); // yank "word" (or "word" depending on trailing), no buffer change

		// Now make a real edit: x deletes 'w' → "ord"
		h.send("x");
		expect(h.state()).toBe("|ord");

		// u should undo the x only, restoring "word"
		h.send("u");
		expect(h.state()).toBe("|word");
	});
});

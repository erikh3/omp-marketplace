/**
 * test/engine/dispatch.test.ts
 *
 * Fake-host dispatch unit tests for the table-driven evaluator (Task 6).
 *
 * These tests drive `evaluate` (via the full editor's `handleInput`) against a
 * real `ModalVimEditor` instance backed by the existing integration harness.
 * They characterise the behaviour cut over from the monolithic switches to
 * the new evaluator; they must stay green against both implementations.
 *
 * Coverage (spec §10 required cases + special forms §5.11.1):
 *   dw, de, dW, cw (ce-behaviour), 2dd, dd, x, 3x, r{c},
 *   p, P, v+l+d, V+j+d, visual o,
 *   gg, G, f{c}, ; (repeat), , (reverse), 0, ^, $, %
 */

import { createHarness, describe, expect, test } from "../support/harness.ts";

// ---------------------------------------------------------------------------
// dw / de / dW
// ---------------------------------------------------------------------------

describe("dw — charwise word delete (exclusive)", () => {
	test("dw from col 0 deletes word+trailing-space", () => {
		const h = createHarness();
		h.seed("|one two");
		h.send("<Esc>dw");
		expect(h.state()).toBe("|two");
		expect(h.ed.mode).toBe("normal");
	});

	test("dw mid-word deletes remainder of word + trailing space", () => {
		const h = createHarness();
		h.seed("one t|wo three");
		h.send("<Esc>dw");
		expect(h.state()).toBe("one |three");
	});
});

describe("de — charwise word-end delete (inclusive)", () => {
	test("de from col 0 deletes word, stops before trailing space", () => {
		const h = createHarness();
		h.seed("|foo bar");
		h.send("<Esc>de");
		expect(h.state()).toBe("| bar");
	});

	test("de on last word deletes the word, trailing space preserved", () => {
		const h = createHarness();
		h.seed("foo b|ar");
		h.send("<Esc>de");
		expect(h.state()).toBe("foo |");
	});
});

describe("dW — delete WORD (non-blank run)", () => {
	test("dW from col 0 deletes 'foo.bar' as one WORD + trailing space", () => {
		const h = createHarness();
		h.seed("|foo.bar baz");
		h.send("<Esc>dW");
		expect(h.state()).toBe("|baz");
	});
});

// ---------------------------------------------------------------------------
// cw — special form: ce on non-blank; w on whitespace
// ---------------------------------------------------------------------------

describe("cw — change word (ce special form on non-blank)", () => {
	test("cw on non-blank enters INSERT after deleting to word-end (inclusive)", () => {
		const h = createHarness();
		h.seed("|foo bar");
		h.send("<Esc>cwXY");
		expect(h.state()).toBe("XY| bar");
		expect(h.ed.mode).toBe("insert");
	});

	test("cw on whitespace changes only the whitespace run to next word (exclusive)", () => {
		const h = createHarness();
		h.seed("foo | bar");
		h.send("<Esc>cw_");
		expect(h.state()).toBe("foo_|bar");
		expect(h.ed.mode).toBe("insert");
	});
});

// ---------------------------------------------------------------------------
// dd / 2dd — linewise delete
// ---------------------------------------------------------------------------

describe("dd — delete current line", () => {
	test("dd deletes the current line and the next line becomes line 0", () => {
		const h = createHarness();
		h.seed("|one\ntwo\nthree");
		h.send("<Esc>dd");
		expect(h.state()).toBe("|two\nthree");
		expect(h.ed.mode).toBe("normal");
	});

	test("dd on a single-line buffer empties it", () => {
		const h = createHarness();
		h.seed("|hello");
		h.send("<Esc>dd");
		expect(h.state()).toBe("|");
	});
});

describe("2dd — counted linewise delete", () => {
	test("2dd deletes two lines", () => {
		const h = createHarness();
		h.seed("|a\nb\nc\nd");
		h.send("<Esc>2dd");
		expect(h.state()).toBe("|c\nd");
	});
});

// ---------------------------------------------------------------------------
// x / 3x — delete grapheme(s) under cursor
// ---------------------------------------------------------------------------

describe("x — delete grapheme under cursor", () => {
	test("x deletes the character under the cursor", () => {
		const h = createHarness();
		h.seed("|hello");
		h.send("<Esc>x");
		expect(h.state()).toBe("|ello");
	});

	test("3x deletes three graphemes", () => {
		const h = createHarness();
		h.seed("|hello world");
		h.send("<Esc>3x");
		expect(h.state()).toBe("|lo world");
	});
});

// ---------------------------------------------------------------------------
// r{c} — replace grapheme under cursor
// ---------------------------------------------------------------------------

describe("r{c} — replace character in-place", () => {
	test("r replaces the grapheme under the cursor without entering INSERT", () => {
		const h = createHarness();
		h.seed("|hello");
		h.send("<Esc>rX");
		expect(h.state()).toBe("|Xello");
		expect(h.ed.mode).toBe("normal");
	});

	test("r mid-word replaces the grapheme at cursor position", () => {
		const h = createHarness();
		h.seed("hel|lo");
		h.send("<Esc>rZ");
		expect(h.state()).toBe("he|Zlo");
	});
});

// ---------------------------------------------------------------------------
// p / P — paste
// ---------------------------------------------------------------------------

describe("p — charwise paste after cursor", () => {
	test("yw then p inserts yanked word after cursor grapheme", () => {
		const h = createHarness();
		h.seed("|foo bar");
		h.send("<Esc>yw$p");
		expect(h.state()).toBe("foo barfoo| ");
	});
});

describe("P — charwise paste before cursor", () => {
	test("yiw then P inserts yanked word before cursor", () => {
		const h = createHarness();
		h.seed("|alpha beta");
		h.send("<Esc>yiwP");
		expect(h.state()).toBe("alph|aalpha beta");
	});
});

// ---------------------------------------------------------------------------
// v + l + d — charwise visual delete
// ---------------------------------------------------------------------------

describe("v + l + d — charwise visual select and delete", () => {
	test("v then l selects two chars, d deletes them", () => {
		const h = createHarness();
		h.seed("|abcde");
		h.send("<Esc>vld");
		expect(h.state()).toBe("|cde");
		expect(h.ed.mode).toBe("normal");
	});

	test("v + 3l + d selects 4 chars and deletes them", () => {
		const h = createHarness();
		h.seed("|hello world");
		h.send("<Esc>v3ld");
		expect(h.state()).toBe("|o world");
	});
});

// ---------------------------------------------------------------------------
// V + j + d — visual-line delete
// ---------------------------------------------------------------------------

describe("V + j + d — visual-line delete two lines", () => {
	test("V + j + d deletes two lines", () => {
		const h = createHarness();
		h.seed("|aaa\nbbb\nccc");
		h.send("<Esc>Vjd");
		expect(h.state()).toBe("|ccc");
		expect(h.ed.mode).toBe("normal");
	});
});

// ---------------------------------------------------------------------------
// visual o — swap selection ends
// ---------------------------------------------------------------------------

describe("visual o — swap anchor and cursor", () => {
	test("v + 2l + o swaps to anchor end; further l extends from the anchor side", () => {
		const h = createHarness();
		h.seed("|abcde");
		h.send("<Esc>v2lo");
		// After v at col 0, 2l → cursor at col 2; o swaps → cursor at col 0, anchor at col 2.
		expect(h.ed.mode).toBe("visual");
		// Subsequent d should delete chars 0..2 inclusive (the swapped selection)
		h.send("d");
		expect(h.state()).toBe("|de");
	});
});

// ---------------------------------------------------------------------------
// gg / G — jump to first / last line
// ---------------------------------------------------------------------------

describe("gg — jump to first line", () => {
	test("gg from line 2 moves to line 0 first non-blank", () => {
		const h = createHarness();
		h.seed("|aaa\nbbb\nccc");
		h.send("<Esc>jjgg");
		expect(h.state()).toBe("|aaa\nbbb\nccc");
	});

	test("{count}gg jumps to the count-th line (1-indexed)", () => {
		const h = createHarness();
		h.seed("|a\nb\nc");
		h.send("<Esc>2gg");
		expect(h.state()).toBe("a\n|b\nc");
	});
});

describe("G — jump to last line", () => {
	test("G from line 0 jumps to the last line", () => {
		const h = createHarness();
		h.seed("|a\nb\nc");
		h.send("<Esc>G");
		expect(h.state()).toBe("a\nb\n|c");
	});
});

// ---------------------------------------------------------------------------
// f{c} — char-find, ; (repeat forward), , (reverse)
// ---------------------------------------------------------------------------

describe("f{c} — find character forward, ; repeats, , reverses", () => {
	test("fo finds the next 'o'", () => {
		const h = createHarness();
		h.seed("|foo bar");
		h.send("<Esc>fo");
		expect(h.state()).toBe("f|oo bar");
	});

	test("; repeats the last char-find forward", () => {
		const h = createHarness();
		h.seed("|foo bar boo");
		h.send("<Esc>fo;");
		// First fo: col 1 ('o'). Second ; → next 'o': col 2? or col 9 ('o' in 'boo')?
		// After fo: col 1. ; → next 'o' from col 1 → col 2.
		expect(h.state()).toBe("fo|o bar boo");
	});

	test(", reverses the last char-find", () => {
		const h = createHarness();
		h.seed("|foo bar");
		h.send("<Esc>fo;,");
		// fo → col 1, ; → col 2, , → col 1
		expect(h.state()).toBe("f|oo bar");
	});
});

// ---------------------------------------------------------------------------
// 0 / ^ / $ — line motions
// ---------------------------------------------------------------------------

describe("0 — move to column 0", () => {
	test("0 moves to the very start of the line", () => {
		const h = createHarness();
		h.seed("  hell|o");
		h.send("<Esc>0");
		expect(h.state()).toBe("|  hello");
	});
});

describe("^ — move to first non-blank", () => {
	test("^ skips leading whitespace", () => {
		const h = createHarness();
		h.seed("  hell|o");
		h.send("<Esc>^");
		expect(h.state()).toBe("  |hello");
	});
});

describe("$ — move to end of line", () => {
	test("$ moves to the end of the line", () => {
		const h = createHarness();
		h.seed("|hello");
		h.send("<Esc>$");
		expect(h.state()).toBe("hello|");
	});
});

// ---------------------------------------------------------------------------
// % — matching pair jump
// ---------------------------------------------------------------------------

describe("% — jump to matching bracket", () => {
	test("% on '(' jumps to matching ')'", () => {
		const h = createHarness();
		h.seed("x(|y)z");
		h.send("<Esc>%");
		// Esc steps back: INSERT col 2 → NORMAL col 1 = '('; % jumps to ')' at col 3
		expect(h.state()).toBe("x(y|)z");
	});

	test("d% deletes inclusive from '(' to ')'", () => {
		const h = createHarness();
		h.seed("x(|y)z");
		h.send("<Esc>d%");
		expect(h.state()).toBe("x|z");
	});
});

/**
 * test/engine/normal-keys.test.ts
 *
 * Behavioural contract for the NORMAL-mode keys added to reach parity with
 * upstream lajarre/pi-vim: `X`, `S`, `_`, `gM`, `J`/`gJ`, and `.` (dot-repeat).
 *
 * All assertions drive a real ModalVimEditor through the integration harness
 * and compare whole cursor-marker buffers, so they characterise observable
 * keystroke behaviour, not internals. Semantics mirror the upstream README's
 * "single-key edits", "join lines", "navigation", and "undo / redo / repeat"
 * sections.
 */

import { createHarness, describe, expect, test } from "../support/harness.ts";

// ---------------------------------------------------------------------------
// X — delete char(s) before cursor
// ---------------------------------------------------------------------------

describe("X — delete char before cursor", () => {
	test("X deletes the grapheme before the cursor", () => {
		const h = createHarness();
		h.seed("abc|d"); // cursor on 'd'
		h.send("<Esc>"); // NORMAL: step left → col 2 ('c')
		h.send("X"); // delete char before cursor ('b')
		expect(h.state()).toBe("a|cd"); // 'c' stays under cursor, now col 1
	});

	test("{count}X deletes count chars before cursor", () => {
		const h = createHarness();
		h.seed("abcde|"); // INSERT, cursor past end
		h.send("<Esc>"); // → col 4 ('e')
		h.send("2X"); // delete 'c' and 'd' (two before cursor at col 4)
		expect(h.state()).toBe("ab|e");
	});

	test("X at column 0 is a no-op", () => {
		const h = createHarness();
		h.seed("|abc");
		h.send("<Esc>"); // col 0
		h.send("X");
		expect(h.state()).toBe("|abc");
	});

	test("{count}X clamps at line start", () => {
		const h = createHarness();
		h.seed("ab|c"); // cursor on 'c'? seed places marker before 'c' → col 2
		h.send("<Esc>"); // → col 1 ('b')
		h.send("9X"); // asks for 9, only 1 char before cursor
		expect(h.state()).toBe("|bc");
	});
});

// ---------------------------------------------------------------------------
// S — change whole line (== cc)
// ---------------------------------------------------------------------------

describe("S — change whole line", () => {
	test("S clears the line and enters INSERT", () => {
		const h = createHarness();
		h.seed("hello wor|ld");
		h.send("<Esc>");
		h.send("S");
		expect(h.ed.mode).toBe("insert");
		expect(h.state()).toBe("|");
	});

	test("S then typing replaces the line content", () => {
		const h = createHarness();
		h.seed("old lin|e");
		h.send("<Esc>");
		h.send("S");
		h.send("new");
		expect(h.state()).toBe("new|");
	});

	test("S preserves other lines", () => {
		const h = createHarness();
		h.seed("one\ntw|o\nthree");
		h.send("<Esc>");
		h.send("S");
		expect(h.ed.mode).toBe("insert");
		expect(h.state()).toBe("one\n|\nthree");
	});
});

// ---------------------------------------------------------------------------
// _ — first non-whitespace (counted line-down)
// ---------------------------------------------------------------------------

describe("_ — first non-whitespace of current/counted line", () => {
	test("_ moves to first non-blank of the current line", () => {
		const h = createHarness();
		h.seed("   he|llo");
		h.send("<Esc>");
		h.send("0"); // to col 0 first
		h.send("_"); // → first non-blank (col 3)
		expect(h.state()).toBe("   |hello");
	});

	test("{count}_ moves down count-1 lines to first non-blank", () => {
		const h = createHarness();
		h.seed("|line one\n  line two\nline three");
		h.send("<Esc>");
		h.send("2_"); // down to line 2, first non-blank (col 2)
		expect(h.state()).toBe("line one\n  |line two\nline three");
	});

	test("d_ deletes the current line linewise", () => {
		const h = createHarness();
		h.seed("a|aa\nbbb\nccc");
		h.send("<Esc>");
		h.send("d_"); // linewise delete of current line
		expect(h.state()).toBe("|bbb\nccc");
	});

	test("d2_ deletes current + next line linewise", () => {
		const h = createHarness();
		h.seed("a|aa\nbbb\nccc");
		h.send("<Esc>");
		h.send("d2_");
		expect(h.state()).toBe("|ccc");
	});
});

// ---------------------------------------------------------------------------
// gM — halfway across the line's text
// ---------------------------------------------------------------------------

describe("gM — halfway across the line", () => {
	test("gM moves to the grapheme midpoint of the line", () => {
		const h = createHarness();
		h.seed("|0123456789"); // 10 chars → midpoint col 5
		h.send("<Esc>");
		h.send("gM");
		expect(h.state()).toBe("01234|56789");
	});

	test("{count}gM moves to that percentage of the line (nvim: 1-100)", () => {
		const h = createHarness();
		h.seed("|0123456789"); // 10 chars
		h.send("<Esc>");
		h.send("20gM"); // 20% of 10 = col 2
		expect(h.state()).toBe("01|23456789");
	});

	test("gM on an empty line stays at col 0", () => {
		const h = createHarness();
		h.seed("|");
		h.send("<Esc>");
		h.send("gM");
		expect(h.state()).toBe("|");
	});
});

// ---------------------------------------------------------------------------
// J / gJ — join lines
// ---------------------------------------------------------------------------

describe("J — join lines with whitespace normalization", () => {
	test("J joins the next line with a single space", () => {
		const h = createHarness();
		h.seed("|hello\nworld");
		h.send("<Esc>");
		h.send("J");
		// cursor lands on the join boundary (the inserted space)
		expect(h.state()).toBe("hello| world");
	});

	test("J strips leading whitespace of the joined line", () => {
		const h = createHarness();
		h.seed("|hello\n    world");
		h.send("<Esc>");
		h.send("J");
		expect(h.state()).toBe("hello| world");
	});

	test("{count}J joins count lines", () => {
		const h = createHarness();
		h.seed("|a\nb\nc");
		h.send("<Esc>");
		h.send("3J"); // join a, b, c
		expect(h.state()).toBe("a b| c");
	});

	test("J at the last line is a no-op", () => {
		const h = createHarness();
		h.seed("one\n|two");
		h.send("<Esc>");
		h.send("J");
		expect(h.state()).toBe("one\n|two");
	});
});

describe("gJ — join lines without whitespace normalization", () => {
	test("gJ joins without inserting or stripping whitespace", () => {
		const h = createHarness();
		h.seed("|hello\n    world");
		h.send("<Esc>");
		h.send("gJ");
		// no space inserted, leading whitespace preserved; cursor at boundary
		expect(h.state()).toBe("hello|    world");
	});

	test("{count}gJ joins count lines raw", () => {
		const h = createHarness();
		h.seed("|a\nb\nc");
		h.send("<Esc>");
		h.send("3gJ");
		expect(h.state()).toBe("ab|c");
	});
});

// ---------------------------------------------------------------------------
// . — dot-repeat
// ---------------------------------------------------------------------------

describe(". — repeat the last change", () => {
	test(". repeats x", () => {
		const h = createHarness();
		h.seed("|abcde");
		h.send("<Esc>");
		h.send("x"); // → "bcde"
		h.send("."); // → "cde"
		expect(h.state()).toBe("|cde");
	});

	test(". repeats dw", () => {
		const h = createHarness();
		h.seed("|one two three four");
		h.send("<Esc>");
		h.send("dw"); // → "two three four"
		h.send("."); // → "three four"
		expect(h.state()).toBe("|three four");
	});

	test(". repeats an insert session (cw + text + Esc)", () => {
		const h = createHarness();
		h.seed("|foo bar");
		h.send("<Esc>");
		h.send("cwX<Esc>"); // change 'foo' → 'X' ; buffer "X bar", cursor on 'X'
		expect(h.state()).toBe("|X bar");
		h.send("w"); // move to 'bar'
		h.send("."); // repeat cw..X on 'bar' → "X X"
		expect(h.state()).toBe("X |X");
	});

	test("{count}. overrides the stored count", () => {
		const h = createHarness();
		h.seed("|abcdefgh");
		h.send("<Esc>");
		h.send("x"); // delete 1 → "bcdefgh"
		h.send("3."); // repeat with count 3 → delete 'b','c','d'
		expect(h.state()).toBe("|efgh");
	});

	test("motions and yanks do not disturb the stored change", () => {
		const h = createHarness();
		h.seed("|abcde");
		h.send("<Esc>");
		h.send("x"); // change: delete 'a' → "bcde"
		expect(h.ed.getText()).toBe("bcde");
		h.send("ll"); // motions (no change)
		h.send("yy"); // yank (no change)
		h.send("gg"); // back to start
		h.send("."); // still repeats x → delete 'b'
		expect(h.ed.getText()).toBe("cde");
	});

	test(". is a no-op before any change", () => {
		const h = createHarness();
		h.seed("|abc");
		h.send("<Esc>");
		h.send("."); // nothing recorded yet
		expect(h.state()).toBe("|abc");
	});

	test(". repeats a paste", () => {
		const h = createHarness();
		h.seed("|abc");
		h.send("<Esc>");
		h.send("yy"); // yank line "abc\n" (no change recorded)
		h.send("p"); // paste below → change (buffer now 2 lines)
		expect(h.ed.getText().split("\n").length).toBe(2);
		h.send("."); // repeat paste
		expect(h.ed.getText().split("\n").length).toBe(3);
	});
});

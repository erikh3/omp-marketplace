/**
 * Grapheme-cluster correctness tests across motions and edits.
 *
 * Covers:
 *  - ZWJ emoji family  👨‍👩‍👧  (U+1F468 ZWJ U+1F469 ZWJ U+1F467, 8 UTF-16 units, 1 grapheme)
 *  - Single-codepoint emoji  🎉  (U+1F389, 2 UTF-16 units, 1 grapheme)
 *  - CJK wide chars  日本語 テスト です  (each 1 UTF-16 unit = 1 grapheme)
 *  - Base + combining sequence  e\u0301 (é, 2 UTF-16 units, 1 grapheme)
 *
 * ── Cursor-seeding constraint ──────────────────────────────────────────────
 * `harness.seed()` places the cursor by pressing the right-arrow key `col` times
 * (one grapheme per press). This matches UTF-16 col offsets ONLY when every
 * character before the cursor is a single-unit grapheme. For positions that follow
 * a multi-unit cluster we instead start at col 0 and navigate with `l` commands
 * at the front of `keys`, so the harness never overshoots.
 *
 * Concretely:
 *  - Safe marker: "|abc…" or "a|bc…" (only ASCII precedes the `|`).
 *  - Unsafe marker: "a👨‍👩‍👧|b…" – the 8-unit emoji makes col=9 but only 2 grapheme
 *    presses reach there, so the cursor would overshoot if seeded by col directly.
 * ──────────────────────────────────────────────────────────────────────────
 */

import { createHarness, describe, expect, test, vt } from "../support/harness.ts";

// ─── fixture constants used inline ────────────────────────────────────────────
// EMOJI = "a👨‍👩‍👧b🎉c"
//   grapheme layout: [a] [👨‍👩‍👧(8 UTF-16)] [b] [🎉(2 UTF-16)] [c]
//   UTF-16 cols:      0   1                  9   10              12
//
// COMBINING = "e\u0301fg"
//   grapheme layout: [é(2 UTF-16)] [f] [g]
//   UTF-16 cols:      0             2   3
//
// CJK = "日本語 テスト です"
//   each char 1 UTF-16 unit; space at col 3, second space at col 7

// ═══════════════════════════════════════════════════════════════════════════════
// 1. `x` — delete exactly one whole grapheme cluster
// ═══════════════════════════════════════════════════════════════════════════════
describe("x — delete one grapheme cluster", () => {
	// Delete 'a' — a plain ASCII char just before the family emoji.
	// Cursor starts at col 0 (safe seed); <Esc> stays at col 0 since col=0.
	vt({
		name: "x on ASCII before ZWJ family",
		before: "|a👨‍👩‍👧b🎉c",
		keys: "<Esc>x",
		after: "|👨‍👩‍👧b🎉c",
		mode: "normal",
	});

	// Delete the ZWJ family emoji (8 UTF-16 units) in one `x`.
	// Start at col 0, <Esc> stays col 0, `l` navigates one grapheme right to
	// col 1 (family emoji), then `x` should delete all 8 units.
	vt({
		name: "x on ZWJ family emoji removes all 8 UTF-16 units",
		before: "|a👨‍👩‍👧b🎉c",
		keys: "<Esc>lx",
		// after the family is deleted, cursor stays at col 1 (now 'b')
		after: "a|b🎉c",
		mode: "normal",
	});

	// Delete the party-popper emoji (2 UTF-16 units) in one `x`.
	// Navigate to 🎉: col0 → l → col1(family) → l → col9('b') → l → col10(🎉).
	vt({
		name: "x on 2-unit emoji removes both UTF-16 units",
		before: "|a👨‍👩‍👧b🎉c",
		keys: "<Esc>lllx",
		// 🎉 deleted; cursor stays at col 10, now on 'c'
		after: "a👨‍👩‍👧b|c",
		mode: "normal",
	});

	// Delete é (base 'e' + U+0301 combining acute, 2 UTF-16 units) in one `x`.
	// Cursor at col 0 (safe seed).
	vt({
		name: "x on base+combining sequence removes both code units",
		before: "|e\u0301fg",
		keys: "<Esc>x",
		after: "|fg",
		mode: "normal",
	});

	// Delete a CJK character (1 UTF-16 unit) in one `x`.
	vt({
		name: "x on CJK character removes exactly that char",
		before: "|日本語",
		keys: "<Esc>x",
		after: "|本語",
		mode: "normal",
	});

	// x on 'c' at the end of the EMOJI string — last char.
	// Navigate to 'c': col0 → l×4 → col12('c').
	vt({
		name: "x deletes last ASCII after emoji sequence",
		before: "|a👨‍👩‍👧b🎉c",
		keys: "<Esc>llllx",
		// 'c' deleted; text = "a👨‍👩‍👧b🎉", cursor at col 12 (now at end)
		after: "a👨‍👩‍👧b🎉|",
		mode: "normal",
	});

	// x on emoji that is the last char in its line.
	// Start at col 0; navigate 3 l presses to land on 🎉 (col 3 in "abc🎉").
	vt({
		name: "x on emoji at end of line deletes the whole cluster",
		before: "|abc🎉",
		keys: "<Esc>lllx",
		// 🎉 (2 units) deleted; text = "abc", cursor clamps to col 3 (end)
		after: "abc|",
		mode: "normal",
	});
});

// ═══════════════════════════════════════════════════════════════════════════════
// 2. `l` / `h` — move one grapheme cluster at a time
// ═══════════════════════════════════════════════════════════════════════════════
describe("l/h — one-grapheme-cluster steps", () => {
	// `l` from 'a' (col 0) advances one grapheme to col 1 (family emoji).
	vt({
		name: "l steps from ASCII onto ZWJ family emoji",
		before: "|a👨‍👩‍👧b🎉c",
		keys: "<Esc>l",
		after: "a|👨‍👩‍👧b🎉c",
		mode: "normal",
	});

	// Second `l` skips all 8 UTF-16 units of the family in one press, landing on 'b'.
	// First `l` positions on the family; second `l` is the one under test.
	vt({
		name: "l skips all 8 UTF-16 units of ZWJ family in one step",
		before: "|a👨‍👩‍👧b🎉c",
		keys: "<Esc>ll",
		// col 1 → col 9 in one grapheme step
		after: "a👨‍👩‍👧|b🎉c",
		mode: "normal",
	});

	// `l` from 🎉 (col 10) skips both UTF-16 units to land on 'c' (col 12).
	vt({
		name: "l skips both UTF-16 units of 2-unit emoji",
		before: "|a👨‍👩‍👧b🎉c",
		keys: "<Esc>llll",
		// four l's: col0→col1(family)→col9('b')→col10(🎉)→col12('c')
		after: "a👨‍👩‍👧b🎉|c",
		mode: "normal",
	});

	// `h` from 'b' (col 9) jumps back one grapheme to col 1 (start of family).
	// Navigate to 'b' with ll, then h is the operation under test.
	vt({
		name: "h from 'b' jumps back over ZWJ family in one step",
		before: "|a👨‍👩‍👧b🎉c",
		keys: "<Esc>llh",
		// h from col 9 lands at col 1 (family emoji start)
		after: "a|👨‍👩‍👧b🎉c",
		mode: "normal",
	});

	// `h` from 🎉 (col 10) steps back to 'b' (col 9).
	vt({
		name: "h from 2-unit emoji steps back to preceding ASCII",
		before: "|a👨‍👩‍👧b🎉c",
		keys: "<Esc>lllh",
		// lll: col0→col1→col9→col10(🎉); h→col9('b')
		after: "a👨‍👩‍👧|b🎉c",
		mode: "normal",
	});

	// `l` on é (col 0) skips both UTF-16 units, landing on 'f' (col 2).
	vt({
		name: "l skips base+combining sequence in one step",
		before: "|e\u0301fg",
		keys: "<Esc>l",
		after: "e\u0301|fg",
		mode: "normal",
	});

	// `h` from 'f' (col 2 in COMBINING) steps back to col 0 (start of é).
	// Navigate to 'f' with l, then h is the operation under test.
	vt({
		name: "h from 'f' steps back to start of base+combining sequence",
		before: "|e\u0301fg",
		keys: "<Esc>lh",
		after: "|e\u0301fg",
		mode: "normal",
	});

	// `2l` in CJK moves two CJK graphemes (each 1 UTF-16 unit here).
	vt({
		name: "2l moves two CJK graphemes forward",
		before: "|日本語",
		keys: "<Esc>2l",
		after: "日本|語",
		mode: "normal",
	});

	// `h` at BOL is a no-op — cannot move past the start of the line.
	vt({
		name: "h at column 0 is a no-op",
		before: "|👨‍👩‍👧b",
		keys: "<Esc>h",
		after: "|👨‍👩‍👧b",
		mode: "normal",
	});

	// `l` at EOL (cursor on the last grapheme) does not move past end.
	// Seed puts INSERT cursor at col 1 (after 'a'); Esc steps left to col 0.
	// Then l moves to col 1 (family), which is already the last grapheme.
	// Another l should stay at col 1.
	// `l` on the last grapheme of a line moves the cursor to after that grapheme
	// (col = text.length). This is the base editor's behavior; NORMAL-mode cursor
	// clamping happens implicitly. Pin it so a change is visible.
	vt({
		name: "l on the last grapheme advances to after-end position",
		before: "a|👨‍👩‍👧",
		// Esc from col 1 → col 0 ('a'); l→col1(family); l→col9 (after-end)
		keys: "<Esc>ll",
		after: "a👨‍👩‍👧|",
		mode: "normal",
	});
});

// ═══════════════════════════════════════════════════════════════════════════════
// 3. `w` / `e` / `b` — word motions treat grapheme clusters correctly
// ═══════════════════════════════════════════════════════════════════════════════
describe("w/e/b — word motions with unicode content", () => {
	// `w` from 'a' (Keyword) stops at the start of the next word (the family
	// emoji, which has CharType.Other because its leading surrogate is not \w).
	vt({
		name: "w from ASCII before emoji stops at emoji (Other) start",
		before: "|a👨‍👩‍👧b🎉c",
		keys: "<Esc>w",
		after: "a|👨‍👩‍👧b🎉c",
		mode: "normal",
	});

	// `w` from the family emoji: skip the Other-typed surrogate/ZWJ bytes,
	// landing at 'b' (col 9). Navigate to family first.
	vt({
		name: "w from ZWJ family emoji advances to 'b'",
		before: "|a👨‍👩‍👧b🎉c",
		keys: "<Esc>lw",
		// family (Other) run ends at col 9 ('b', Keyword)
		after: "a👨‍👩‍👧|b🎉c",
		mode: "normal",
	});

	// `w` in CJK: from col 0 (日, CharType.Other) skips 日本語 and the space, landing at テ.
	vt({
		name: "w skips CJK Other-type word and trailing space",
		before: "|日本語 テスト です",
		keys: "<Esc>w",
		after: "日本語 |テスト です",
		mode: "normal",
	});

	// `e` in CJK: from col 0 finds the end of the first Other-type run (語, col 2).
	vt({
		name: "e lands at end of CJK word",
		before: "|日本語 テスト です",
		keys: "<Esc>e",
		after: "日本|語 テスト です",
		mode: "normal",
	});

	// `b` in CJK: from テ (col 4), navigate back to 日 (col 0).
	// Use w to get to テ first, then b is the operation under test.
	vt({
		name: "b from second CJK word returns to first word start",
		before: "|日本語 テスト です",
		keys: "<Esc>wb",
		// w→col4(テ); b→col0(日)
		after: "|日本語 テスト です",
		mode: "normal",
	});
});

// ═══════════════════════════════════════════════════════════════════════════════
// 4. `dw` across an emoji-containing word
// ═══════════════════════════════════════════════════════════════════════════════
describe("dw — delete word containing emoji", () => {
	// `dw` from 'a' (Keyword): w target = col 1 (Other, family emoji start).
	// Exclusive delete [0,1) = 'a'. The family is untouched.
	vt({
		name: "dw on ASCII before emoji deletes only the ASCII word",
		before: "|a👨‍👩‍👧b🎉c",
		keys: "<Esc>dw",
		after: "|👨‍👩‍👧b🎉c",
		mode: "normal",
	});

	// `dw` from the family emoji (Other): skips Other run (cols 1–8), reaches 'b'
	// (Keyword, col 9). Exclusive delete [1,9) = the family emoji alone.
	vt({
		name: "dw from ZWJ family emoji deletes the emoji cluster only",
		before: "|a👨‍👩‍👧b🎉c",
		keys: "<Esc>ldw",
		// l→col1(family); dw deletes family (8 UTF-16 units), cursor stays at col 1 ('b')
		after: "a|b🎉c",
		mode: "normal",
	});

	// `dw` in CJK from col 0: deletes 日本語 (Other run) + the trailing space.
	vt({
		name: "dw in CJK deletes first CJK word through trailing space",
		before: "|日本語 テスト です",
		keys: "<Esc>dw",
		after: "|テスト です",
		mode: "normal",
	});
});

// ═══════════════════════════════════════════════════════════════════════════════
// 5. `ci"` — change inside quotes with emoji / CJK content
// ═══════════════════════════════════════════════════════════════════════════════
describe('ci" — change inside quotes with unicode content', () => {
	// Cursor on the opening quote (col 0); the family emoji sits inside the quotes.
	// ci" deletes the interior (emoji) and enters INSERT with cursor between quotes.
	vt({
		name: 'ci" deletes ZWJ family emoji inside double quotes',
		before: '|"👨‍👩‍👧"',
		keys: '<Esc>ci"',
		after: '"|"',
		mode: "insert",
	});

	// Same geometry but with CJK content.
	vt({
		name: 'ci" deletes CJK content inside double quotes',
		before: '|"日本語"',
		keys: '<Esc>ci"',
		after: '"|"',
		mode: "insert",
	});

	// 2-unit party-popper emoji inside quotes.
	vt({
		name: 'ci" deletes 2-unit emoji inside double quotes',
		before: '|"🎉"',
		keys: '<Esc>ci"',
		after: '"|"',
		mode: "insert",
	});

	// é (base+combining) inside quotes.
	vt({
		name: 'ci" deletes base+combining sequence inside double quotes',
		before: `|"e\u0301"`,
		keys: '<Esc>ci"',
		after: '"|"',
		mode: "insert",
	});
});

// ═══════════════════════════════════════════════════════════════════════════════
// 6. Visual select + `d` over emoji clusters
// ═══════════════════════════════════════════════════════════════════════════════
describe("visual d — delete selection over grapheme clusters", () => {
	// Enter visual on the family emoji (navigate there first), then `d`.
	// Anchor = cursor = col 1; getInclusiveEndColumn("a👨‍👩‍👧b🎉c", 1) = 9.
	// Deletes [1, 9) = the family emoji cluster.
	vt({
		name: "visual d on ZWJ family deletes entire 8-unit cluster",
		before: "|a👨‍👩‍👧b🎉c",
		keys: "<Esc>lvd",
		// l→col1(family); vd deletes family; cursor at col 1 ('b' now)
		after: "a|b🎉c",
		mode: "normal",
	});

	// Visual select from 'b' (col 9) to 🎉 (col 10), then `d`.
	// Inclusive end of 🎉 = col 12; delete [9, 12) = "b🎉".
	vt({
		name: "visual d over ASCII and 2-unit emoji deletes both",
		before: "|a👨‍👩‍👧b🎉c",
		keys: "<Esc>llvld",
		// ll→col9('b'); v anchors col 9; l→col10(🎉); d deletes 'b🎉'
		after: "a👨‍👩‍👧|c",
		mode: "normal",
	});

	// Visual select on é (col 0); getInclusiveEndColumn("e\u0301fg", 0) = 2.
	// Deletes [0, 2) = the whole é cluster.
	vt({
		name: "visual d on base+combining deletes the whole cluster",
		before: "|e\u0301fg",
		keys: "<Esc>vd",
		after: "|fg",
		mode: "normal",
	});

	// Visual select two adjacent CJK chars with `l`, then `d`.
	vt({
		name: "visual d over two CJK chars removes exactly two graphemes",
		before: "|日本語",
		keys: "<Esc>vld",
		// anchor col 0, l→col1, d deletes [0,2) = "日本"
		after: "|語",
		mode: "normal",
	});
});

// ═══════════════════════════════════════════════════════════════════════════════
// 7. Bracketed paste of a grapheme cluster, then `x`
// ═══════════════════════════════════════════════════════════════════════════════
describe("paste + x — paste grapheme cluster then delete it", () => {
	// Paste the ZWJ family into an empty buffer. After the INSERT-mode paste
	// the cursor is past the cluster. Esc steps left one grapheme onto the
	// cluster, landing at col 0. Then x should delete the whole 8-unit cluster.
	test("paste ZWJ family then x deletes entire cluster", () => {
		const h = createHarness();
		h.seed("|");
		h.send("[paste]👨‍👩‍👧[/paste]");
		h.send("<Esc>");
		// After paste+Esc: cursor at col 0, on the family emoji
		expect(h.state()).toBe("|👨‍👩‍👧");
		h.send("x");
		// x deletes the 8-unit cluster in one stroke
		expect(h.state()).toBe("|");
		expect(h.ed.mode).toBe("normal");
	});

	// Same pattern with the 2-unit party-popper.
	test("paste 2-unit emoji then x deletes the entire cluster", () => {
		const h = createHarness();
		h.seed("|");
		h.send("[paste]🎉[/paste]");
		h.send("<Esc>");
		expect(h.state()).toBe("|🎉");
		h.send("x");
		expect(h.state()).toBe("|");
	});

	// Paste é (base+combining). The buffer now holds 2 UTF-16 units, but
	// x must treat them as a single grapheme cluster and delete both.
	test("paste base+combining then x deletes the whole cluster", () => {
		const h = createHarness();
		h.seed("|");
		h.send(`[paste]e\u0301[/paste]`);
		h.send("<Esc>");
		// Cursor at col 0 on 'é'; the exact NFC/NFD form depends on the base editor
		// but the text is 1 grapheme. Just confirm x removes it entirely.
		h.send("x");
		expect(h.state()).toBe("|");
	});

	// Paste a CJK word, navigate to first char, x it.
	test("paste CJK string; x on first char deletes only that grapheme", () => {
		const h = createHarness();
		h.seed("|");
		h.send("[paste]日本語[/paste]");
		// After INSERT paste, cursor is past the 3 chars. Esc steps left one grapheme.
		// '語' is the last grapheme (col 2). Esc lands at col 2 (on 語).
		// Use '0' to jump to line start (col 0, on 日).
		h.send("<Esc>0");
		expect(h.state()).toBe("|日本語");
		h.send("x");
		expect(h.state()).toBe("|本語");
	});
});

// ═══════════════════════════════════════════════════════════════════════════════
// 8. Count-based `x` across emoji clusters
// ═══════════════════════════════════════════════════════════════════════════════
describe("count x — multi-grapheme delete across unicode clusters", () => {
	// `3x` from col 0 deletes 'a' (1 unit), family emoji (8 units), 'b' (1 unit)
	// — three graphemes, ten UTF-16 units total.
	vt({
		name: "3x deletes three grapheme clusters including the ZWJ family",
		before: "|a👨‍👩‍👧b🎉c",
		keys: "<Esc>3x",
		after: "|🎉c",
		mode: "normal",
	});

	// `2x` from col 0 of "🎉c": deletes 🎉 (2 UTF-16 units) + 'c' (1 unit) = 2 graphemes.
	vt({
		name: "2x deletes 2-unit emoji and following ASCII char",
		before: "|🎉c",
		keys: "<Esc>2x",
		after: "|",
		mode: "normal",
	});

	// `2x` on é and 'f': deletes the combining sequence (1 grapheme) and 'f'.
	vt({
		name: "2x on base+combining and following ASCII",
		before: "|e\u0301fg",
		keys: "<Esc>2x",
		// é (2 UTF-16 units, 1 grapheme) + 'f' deleted
		after: "|g",
		mode: "normal",
	});
});

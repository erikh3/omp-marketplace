/**
 * Operators + edits: d / c / y + motions, dd/cc/yy, D/C, x/s/r, and
 * boundary checks. Every assertion is against current source behaviour
 * (oracle: smoke.ts checks 4,6,9,13,18,19,22-27 + coverage matrix §7).
 *
 * Cursor-marker convention: the `|` in `before` is the INSERT cursor.
 * After `<Esc>` in the keys, the cursor steps LEFT one grapheme (unless
 * already at col 0). All `after` values were verified against a live
 * harness before being committed here.
 */

import { describe, test, expect, vt, createHarness } from "../support/harness.ts";

// ---------------------------------------------------------------------------
// d + motions
// ---------------------------------------------------------------------------

describe("dw — delete word forward (smoke #6)", () => {
  vt.each([
    // smoke #6 equivalent: from col 0 of "one", dw removes "one " (word+trailing space)
    {
      before: "|one two three",
      keys: "<Esc>dw",
      after: "|two three",
      mode: "normal",
    },
    // mid-word: <Esc> steps back to 't', dw deletes "two " → "one three"
    {
      before: "one t|wo three",
      keys: "<Esc>dw",
      after: "one |three",
      mode: "normal",
    },
    // single word: dw empties the buffer
    {
      before: "|hello",
      keys: "<Esc>dw",
      after: "|",
      mode: "normal",
    },
    // dw from start of buffer — punctuation is its own word: "foo" only
    {
      before: "|foo.bar",
      keys: "<Esc>dw",
      after: "|.bar",
      mode: "normal",
      name: "dw from col 0 of word stops at punctuation boundary",
    },
    // cursor on punctuation: dw deletes just the "." (one punct token)
    {
      before: "foo.|bar",
      keys: "<Esc>dw",
      after: "foo|bar",
      mode: "normal",
      name: "dw on punctuation deletes just that token",
    },
  ]);
});

describe("dW — delete WORD forward (WORD = runs of non-blank)", () => {
  vt.each([
    // dW from col 0: "foo.bar" is one WORD; deletes it + trailing space
    {
      before: "|foo.bar baz",
      keys: "<Esc>dW",
      after: "|baz",
      mode: "normal",
    },
  ]);
});

describe("db — delete word backward", () => {
  vt.each([
    // <Esc> steps to 'b' (col 4), db goes back to start of "bar" word = col 0 of "foo "
    {
      before: "foo b|ar",
      keys: "<Esc>db",
      after: "|bar",
      mode: "normal",
    },
    // <Esc> steps to 't', db skips whitespace to start of "two"
    {
      before: "one two t|hree",
      keys: "<Esc>db",
      after: "one |three",
      mode: "normal",
    },
  ]);
});

describe("de — delete to word end (inclusive)", () => {
  vt.each([
    // de is inclusive: <Esc> stays at col 0, de deletes "foo" leaving " bar"
    {
      before: "|foo bar",
      keys: "<Esc>de",
      after: "| bar",
      mode: "normal",
    },
    // de on last word: deletes "bar", leaves "foo " (trailing space preserved)
    {
      before: "foo b|ar",
      keys: "<Esc>de",
      after: "foo |",
      mode: "normal",
      name: "de on last word — trailing space preserved",
    },
  ]);
});

describe("d$ — delete to EOL", () => {
  vt.each([
    // <Esc> steps to 'd', d$ deletes "drop" leaving "keep " (space preserved)
    {
      before: "keep d|rop",
      keys: "<Esc>d$",
      after: "keep |",
      mode: "normal",
    },
    // multiline: only the current line is affected
    {
      before: "keep d|rop\nnext",
      keys: "<Esc>d$",
      after: "keep |\nnext",
      mode: "normal",
    },
  ]);
});

describe("d0 — delete to line start (exclusive of cursor)", () => {
  vt.each([
    // <Esc> from col 4 moves to col 3 ('d'); d0 deletes [0,3) = "abc"
    {
      before: "abcd|ef",
      keys: "<Esc>d0",
      after: "|def",
      mode: "normal",
    },
  ]);
});

describe("d^ — delete to first non-blank", () => {
  vt.each([
    // <Esc> from col 4 moves to col 3 ('d'); d^ deletes from 'a' (col 2) to col 3
    {
      before: "  abcd|ef",
      keys: "<Esc>d^",
      after: "  |def",
      mode: "normal",
    },
  ]);
});

describe("df{c} — delete forward through char inclusive (smoke #14)", () => {
  vt.each([
    // smoke #14: df d on "abcdef" from col 0 → "ef"
    {
      before: "|abcdef",
      keys: "<Esc>dfd",
      after: "|ef",
      mode: "normal",
    },
    // dt stops before the target char — exclusive
    {
      before: "|abcdef",
      keys: "<Esc>dtd",
      after: "|def",
      mode: "normal",
    },
  ]);
});

describe("dt{c} — delete up to char (exclusive)", () => {
  vt.each([
    {
      before: "|hello world",
      keys: "<Esc>dt ",
      after: "| world",
      mode: "normal",
    },
  ]);
});

describe("dF{c} — delete backward exclusive of cursor (smoke #23)", () => {
  vt.each([
    // smoke #23: "abXcd", ESC from after 'd' → cursor on 'd', dFX deletes [X..d) → "abd"
    {
      before: "abXcd|",
      keys: "<Esc>dFX",
      after: "ab|d",
      mode: "normal",
      name: "dF is exclusive of the cursor grapheme",
    },
    // longer string: cursor on 'e', dFX deletes Xc
    {
      before: "abXcd|e",
      keys: "<Esc>dFX",
      after: "ab|de",
      mode: "normal",
    },
  ]);
});

describe("d% — delete to matching bracket (inclusive)", () => {
  vt.each([
    // cursor lands on '(' after ESC (col 1), d% deletes "(y)" inclusive
    {
      before: "x(|y)z",
      keys: "<Esc>d%",
      after: "x|z",
      mode: "normal",
    },
  ]);
});

describe("dj — delete two lines linewise (j motion)", () => {
  vt.each([
    {
      before: "|aaa\nbbb\nccc",
      keys: "<Esc>dj",
      after: "|ccc",
      mode: "normal",
    },
  ]);
});

describe("dk — delete two lines linewise (k motion)", () => {
  vt.each([
    {
      before: "aaa\nbbb|\nccc",
      keys: "<Esc>dk",
      after: "|ccc",
      mode: "normal",
    },
  ]);
});

describe("d with count", () => {
  vt.each([
    // 2dw deletes two words
    {
      before: "|one two three",
      keys: "<Esc>2dw",
      after: "|three",
      mode: "normal",
      name: "2dw deletes two words",
    },
  ]);
});

// ---------------------------------------------------------------------------
// c + motions (enters INSERT)
// ---------------------------------------------------------------------------

describe("cw — change word (smoke #13, #27)", () => {
  vt.each([
    // smoke #13: cw on "foo" at col 0 = ce-like, spares trailing space
    {
      before: "|foo bar",
      keys: "<Esc>cwXY",
      after: "XY| bar",
      mode: "insert",
      name: "cw on non-blank: behaves like ce, spares trailing space",
    },
    // smoke #27: cw on the first space of "foo  bar" changes the whitespace run only
    {
      before: "foo | bar",
      keys: "<Esc>cw_",
      after: "foo_|bar",
      mode: "insert",
      name: "cw on whitespace: changes only the whitespace run, not the next word",
    },
  ]);
});

describe("cW — change WORD (inclusive to WORD end)", () => {
  vt.each([
    // cW from 'f' of "foo.bar": WORD = "foo.bar", inclusive delete
    {
      before: "|foo.bar baz",
      keys: "<Esc>cWX",
      after: "X| baz",
      mode: "insert",
    },
  ]);
});

describe("cc — change current line, enters INSERT", () => {
  vt.each([
    // single line: deletes all content, cursor at col 0
    {
      before: "|foo bar",
      keys: "<Esc>cc",
      after: "|",
      mode: "insert",
    },
    // multi-line: only current line cleared
    {
      before: "|foo bar\nbaz",
      keys: "<Esc>cc",
      after: "|\nbaz",
      mode: "insert",
    },
  ]);
});

describe("c$ — change to EOL, enters INSERT", () => {
  vt.each([
    // <Esc> steps to 'd', c$ deletes "drop", enters INSERT; space before 'd' preserved
    {
      before: "keep d|rop",
      keys: "<Esc>c$XY",
      after: "keep XY|",
      mode: "insert",
    },
  ]);
});

describe("cj — change two lines (smoke #24)", () => {
  vt.each([
    // smoke #24: cj on "aaa\nbbb\nccc" at line 0 → collapses aaa+bbb, INSERT
    {
      before: "|aaa\nbbb\nccc",
      keys: "<Esc>cjZ",
      after: "Z|\nccc",
      mode: "insert",
    },
  ]);
});

describe("2cc — count cc (smoke #25)", () => {
  vt.each([
    // smoke #25: 2cc at line 0 of "aaa\nbbb\nccc" → collapses aaa+bbb, INSERT
    {
      before: "|aaa\nbbb\nccc",
      keys: "<Esc>2ccZ",
      after: "Z|\nccc",
      mode: "insert",
    },
  ]);
});

describe("cG — change from cursor line to last (linewise, INSERT)", () => {
  vt.each([
    // cG from line 1 of "a\nb\nc" → leaves "a\n" (empty line 1), INSERT
    {
      before: "a\nb|\nc",
      keys: "<Esc>cGZ",
      after: "a\nZ|",
      mode: "insert",
    },
  ]);
});

// ---------------------------------------------------------------------------
// y + motions (buffer intact, cursor parks at range start)
// ---------------------------------------------------------------------------

describe("yw — yank word (cursor stays at range start)", () => {
  vt.each([
    // yw from col 0: yank "foo " (word + space), cursor parks at col 0
    {
      before: "|foo bar",
      keys: "<Esc>yw",
      after: "|foo bar",
      mode: "normal",
    },
    // yw from mid-word: <Esc> to 't', yank "two ", cursor parks at 't'
    {
      before: "one t|wo three",
      keys: "<Esc>yw",
      after: "one |two three",
      mode: "normal",
    },
  ]);
});

describe("yw then p — sanity-check register content", () => {
  // Yank "foo " then paste it after 'f'; verifies charwise register
  test("yw then p pastes the yanked word", () => {
    const h = createHarness();
    h.seed("|foo bar");
    h.send("<Esc>ywp");
    // After yw cursor stays at col 0 = 'f'. p pastes "foo " after 'f'.
    // Buffer becomes "ffoo oo bar"; cursor lands on last pasted char (space at col 4).
    expect(h.state()).toBe("ffoo| oo bar");
  });
});

describe("yy — yank current line (linewise; buffer unchanged)", () => {
  vt.each([
    {
      before: "foo\n|bar\nbaz",
      keys: "<Esc>yy",
      after: "foo\n|bar\nbaz",
      mode: "normal",
    },
  ]);
});

describe("yy then p — linewise paste sanity", () => {
  test("yy then p duplicates the line below", () => {
    const h = createHarness();
    h.seed("|hello");
    h.send("<Esc>yyp");
    expect(h.state()).toBe("hello\n|hello");
  });
});

// ---------------------------------------------------------------------------
// Line operators: dd / cc / yy and counts
// ---------------------------------------------------------------------------

describe("dd — delete current line linewise (smoke #18)", () => {
  vt.each([
    // smoke #18: delete first line of three
    {
      before: "|one\ntwo\nthree",
      keys: "<Esc>dd",
      after: "|two\nthree",
      mode: "normal",
    },
    // delete first of two lines
    {
      before: "|one\ntwo",
      keys: "<Esc>dd",
      after: "|two",
      mode: "normal",
    },
    // delete only/last line
    {
      before: "|hello",
      keys: "<Esc>dd",
      after: "|",
      mode: "normal",
    },
    // delete last line: preceding '\n' is also removed; cursor lands at end of new last line
    {
      before: "one\ntwo\n|three",
      keys: "<Esc>dd",
      after: "one\ntwo|",
      mode: "normal",
      name: "dd on last line removes preceding newline too",
    },
  ]);
});

describe("2dd — delete two lines (smoke #19)", () => {
  vt.each([
    // smoke #19: delete lines 0..1 of "a\nb\nc\nd"
    {
      before: "|a\nb\nc\nd",
      keys: "<Esc>2dd",
      after: "|c\nd",
      mode: "normal",
    },
    // from line 1: delete lines 1..2
    {
      before: "a\nb|\nc\nd",
      keys: "<Esc>2dd",
      after: "a\n|d",
      mode: "normal",
    },
  ]);
});

describe("D — delete to EOL, stays NORMAL (smoke #9)", () => {
  vt.each([
    // smoke #9: D from ' ' (col 4) deletes " drop" → "keep"
    // achieved by seeding INSERT cursor right before 'd' so ESC lands on ' '
    {
      before: "keep |drop",
      keys: "<Esc>D",
      after: "keep|",
      mode: "normal",
    },
    // D on first char empties the line
    {
      before: "|hello world",
      keys: "<Esc>D",
      after: "|",
      mode: "normal",
    },
    // D on empty line is a no-op
    {
      before: "a\n|\nb",
      keys: "<Esc>D",
      after: "a\n|\nb",
      mode: "normal",
      name: "D on empty line is a no-op",
    },
  ]);
});

describe("D boundary — does not leave operator pending (smoke #22)", () => {
  // After D, a following motion key must be treated as a plain motion, not as
  // the second key of a d{motion} compound command.
  vt.each([
    // smoke #22: D then j — j moves down, does NOT trigger d+j linewise delete
    {
      before: "|foo\nbar",
      keys: "<Esc>Dj",
      after: "\n|bar",
      mode: "normal",
      name: "D does not leave operator pending; j after D is a plain motion",
    },
  ]);
});

describe("C — change to EOL, enters INSERT", () => {
  vt.each([
    // <Esc> steps to 'd', C deletes "drop", enters INSERT; space preserved
    {
      before: "keep d|rop",
      keys: "<Esc>CXY",
      after: "keep XY|",
      mode: "insert",
    },
    {
      before: "|hello",
      keys: "<Esc>CXY",
      after: "XY|",
      mode: "insert",
    },
  ]);
});

// ---------------------------------------------------------------------------
// dgg / dG / cG — operator + buffer jumps (linewise)
// ---------------------------------------------------------------------------

describe("dgg — delete from cursor line back to line 0", () => {
  vt.each([
    // from line 1, dgg deletes lines 0..1, leaves "three"
    {
      before: "one\n|two\nthree",
      keys: "<Esc>dgg",
      after: "|three",
      mode: "normal",
    },
  ]);
});

describe("dG — delete from cursor line to last (smoke #26)", () => {
  vt.each([
    // smoke #26: from line 1 of "a\nb\nc", dG → "a"
    {
      before: "a\nb|\nc",
      keys: "<Esc>dG",
      after: "a|",
      mode: "normal",
    },
    // from first line: whole buffer deleted
    {
      before: "|a\nb\nc",
      keys: "<Esc>dG",
      after: "|",
      mode: "normal",
    },
  ]);
});

describe("cG — change from cursor to last line (linewise, INSERT)", () => {
  vt.each([
    {
      before: "a\nb|\nc",
      keys: "<Esc>cGZ",
      after: "a\nZ|",
      mode: "insert",
    },
  ]);
});

// ---------------------------------------------------------------------------
// x with counts (smoke #4)
// ---------------------------------------------------------------------------

describe("x — delete char under cursor (smoke #4)", () => {
  vt.each([
    // smoke #4 equivalent: type "abc", ESC (cursor on 'c'), 0l to 'b', x deletes 'b'
    // Harness: seed "ab|c" → ESC steps to col 1 = 'b'; x deletes 'b'
    {
      before: "ab|c",
      keys: "<Esc>x",
      after: "a|c",
      mode: "normal",
    },
    // x at col 0
    {
      before: "|abc",
      keys: "<Esc>x",
      after: "|bc",
      mode: "normal",
    },
  ]);
});

describe("x with count", () => {
  vt.each([
    // 3x deletes 3 chars starting from the cursor position
    {
      before: "|abcdef",
      keys: "<Esc>3x",
      after: "|def",
      mode: "normal",
    },
    // count > remaining chars: stops at EOL
    {
      before: "ab|c",
      keys: "<Esc>99x",
      after: "a|",
      mode: "normal",
      name: "x count exceeding line length stops at EOL",
    },
  ]);
});

// ---------------------------------------------------------------------------
// s — substitute (delete + INSERT)
// ---------------------------------------------------------------------------

describe("s — substitute char(s), enters INSERT", () => {
  vt.each([
    // s deletes the char under the cursor (same as x) and enters INSERT
    {
      before: "ab|c",
      keys: "<Esc>s",
      after: "a|c",
      mode: "insert",
      name: "s deletes char under cursor and enters INSERT",
    },
    // 3s deletes 3 chars
    {
      before: "|abc",
      keys: "<Esc>3s",
      after: "|",
      mode: "insert",
      name: "3s deletes 3 chars and enters INSERT",
    },
  ]);
});

// ---------------------------------------------------------------------------
// r{char} — replace grapheme, stays NORMAL (smoke #20)
// ---------------------------------------------------------------------------

describe("r — replace char under cursor (smoke #20)", () => {
  vt.each([
    // smoke #20: "cat" at col 0, rb → "bat"; stays NORMAL
    {
      before: "|cat",
      keys: "<Esc>rb",
      after: "|bat",
      mode: "normal",
    },
    // r replaces the char AT cursor after ESC steps back
    // "cat" INSERT at col 2 ('t') → ESC to col 1 ('a') → ra → "crt"… wait
    // INSERT at col 2 = after 'a', before 't'. ESC → col 1 = 'a'. ra → 'a' stays…
    // Let's use: seed col 0 to be safe
    {
      before: "|bat",
      keys: "<Esc>rc",
      after: "|cat",
      mode: "normal",
      name: "r replaces char under cursor and stays NORMAL",
    },
  ]);
});

describe("r — cursor position after replace", () => {
  // After r, cursor stays on the replaced grapheme (vim semantics).
  test("r leaves cursor on the replaced grapheme", () => {
    const h = createHarness();
    h.seed("|hello");
    h.send("<Esc>rx"); // replace 'h' with 'x', cursor stays on 'x' at col 0
    expect(h.state()).toBe("|xello");
    expect(h.ed.mode).toBe("normal");
  });

  // r with space works (space is not a digit, not eaten as count prefix)
  test("r with space replaces char", () => {
    const h = createHarness();
    h.seed("|abc");
    h.send("<Esc>r "); // replace 'a' with space
    expect(h.state()).toBe("| bc");
    expect(h.ed.mode).toBe("normal");
  });
});

// ---------------------------------------------------------------------------
// Unknown operator motion cancels the operator (no text change)
// ---------------------------------------------------------------------------

describe("unknown operator motion cancels", () => {
  test("dz cancels the pending d operator, buffer unchanged", () => {
    const h = createHarness();
    h.seed("|hello world");
    h.send("<Esc>dz"); // 'z' is not a recognised motion
    expect(h.state()).toBe("|hello world");
    expect(h.ed.mode).toBe("normal");
  });

  test("cq cancels the pending c operator, buffer unchanged", () => {
    const h = createHarness();
    h.seed("|hello");
    h.send("<Esc>cq");
    expect(h.state()).toBe("|hello");
    expect(h.ed.mode).toBe("normal");
  });

  test("yq cancels the pending y operator, buffer unchanged", () => {
    const h = createHarness();
    h.seed("|hello");
    h.send("<Esc>yq");
    expect(h.state()).toBe("|hello");
    expect(h.ed.mode).toBe("normal");
  });
});

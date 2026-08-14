/**
 * Pure cursor motions in NORMAL mode (no operator).
 *
 * Oracle: smoke.ts checks 3, 7, 12, 14, 15, 21, 18 and the README motion table.
 *
 * Convention: `before` is INSERT-mode cursor; NORMAL cases begin keys with `<Esc>`.
 * `<Esc>` backs the cursor up one grapheme (unless already at col 0), so to
 * position the NORMAL cursor at col N > 0, seed `before` with the `|` at col N+1.
 * To position at col 0, seed `|` at col 0.
 *
 * Implementation notes vs real vim:
 *  - `$` / `moveToLineEnd()` places the cursor at `text.length` (one past the
 *    last char), matching INSERT behaviour, not on the last char.
 *  - `l` can also land at `text.length` (no hard clamp at last char).
 *  - `j` at the last line moves to EOL (base editor arrow behaviour).
 */

import { describe, vt, createHarness } from "../support/harness.ts";
import { BRACKETS, PARAGRAPHS } from "../support/fixtures.ts";

// ---------------------------------------------------------------------------
// h / l — left / right (smoke #7 covers count)
// ---------------------------------------------------------------------------

describe("l — move right", () => {
  vt.each([
    // single step from col 0 (smoke #7 pattern)
    { before: "|abc",  keys: "<Esc>l",  after: "a|bc",  mode: "normal" },
    // count prefix — smoke #7: 3l from col 0 on "abcdef" → col 3 ('d')
    { before: "|abcdef", keys: "<Esc>3l", after: "abc|def", mode: "normal" },
    // l at last char: Esc backs up to col 1 ('b'), l → col 2 = past last
    // (implementation does not hard-clamp l at last char)
    { before: "ab|",   keys: "<Esc>l",  after: "ab|",  mode: "normal",
      name: "l past last char goes to text.length (no hard clamp)" },
  ]);
});

describe("h — move left", () => {
  vt.each([
    // seed: "ab|c" → INSERT col 2, Esc → col 1 ('b'), h → col 0
    { before: "ab|c", keys: "<Esc>h", after: "|abc", mode: "normal" },
    // count: 3l from col 0 lands on col 3 ('d'); then 3h backs to col 0
    { before: "|abcdef", keys: "<Esc>3l3h", after: "|abcdef", mode: "normal",
      name: "3l then 3h returns to col 0" },
    // h at col 0 is a no-op
    { before: "|abc", keys: "<Esc>h", after: "|abc", mode: "normal",
      name: "h at BOL is a no-op" },
  ]);
});

// ---------------------------------------------------------------------------
// j / k — down / up
// ---------------------------------------------------------------------------

describe("j — move down", () => {
  vt.each([
    // col 0 → col 0 on next line
    {
      before: "|first\nsecond",
      keys: "<Esc>j",
      after: "first\n|second",
      mode: "normal",
      name: "j from col 0 preserves col on next line",
    },
    // col 2 → col 2 on next line ("fir|st\nsecond" → Esc → col 2 = 'r', j → col 2 of "second" = 'c')
    {
      before: "fir|st\nsecond",
      keys: "<Esc>j",
      after: "first\nse|cond",
      mode: "normal",
      name: "j preserves column going down",
    },
    // count: 2j from line 0 lands on line 2
    {
      before: "|line1\nline2\nline3",
      keys: "<Esc>2j",
      after: "line1\nline2\n|line3",
      mode: "normal",
    },
  ]);
});

describe("k — move up", () => {
  vt.each([
    {
      before: "first\n|second",
      keys: "<Esc>k",
      after: "|first\nsecond",
      mode: "normal",
    },
    // count
    {
      before: "line1\nline2\n|line3",
      keys: "<Esc>2k",
      after: "|line1\nline2\nline3",
      mode: "normal",
    },
    // k at first line moves cursor to col 0 of line 0 (base editor up arrow behaviour)
    {
      before: "ab|cde\nfoo",
      keys: "<Esc>k",
      after: "|abcde\nfoo",
      mode: "normal",
      name: "k at first line goes to line start (base editor up-arrow edge behaviour)",
    },
  ]);
});

// ---------------------------------------------------------------------------
// w / W — word / WORD start forward (smoke #12 for w)
// ---------------------------------------------------------------------------

describe("w — word start forward", () => {
  vt.each([
    // smoke #12: w from 'f' on "foo bar baz" → 'b' at col 4
    { before: "|foo bar baz", keys: "<Esc>w", after: "foo |bar baz", mode: "normal" },
    // count: 2w skips two words
    { before: "|foo bar baz", keys: "<Esc>2w", after: "foo bar |baz", mode: "normal" },
    // punctuation boundary: '.' is its own word; w from 'f' of "foo.bar" → '.' at col 3
    { before: "f|oo.bar", keys: "<Esc>w", after: "foo|.bar", mode: "normal",
      name: "w: punctuation forms its own word boundary" },
    // w from '.' → 'b' at col 4
    { before: "foo.|bar", keys: "<Esc>w", after: "foo.|bar", mode: "normal",
      name: "w from '.' moves to next keyword word" },
    // cross-line: w at EOL jumps to first non-blank of next line
    {
      before: "foo|\nbar",
      keys: "<Esc>w",
      after: "foo\n|bar",
      mode: "normal",
      name: "w cross-line to next word",
    },
  ]);
});

describe("W — WORD start forward (punctuation agnostic)", () => {
  vt.each([
    // WORD treats "foo.bar" as a single unit: W from col 0 → 'b' at col 8 (after space)
    { before: "|foo.bar baz", keys: "<Esc>W", after: "foo.bar |baz", mode: "normal" },
    // 1W on "foo bar": from col 0, skips "foo " → col 4 = 'b'
    { before: "|foo bar", keys: "<Esc>W", after: "foo |bar", mode: "normal",
      name: "W skips to next WORD start" },
  ]);
});

// ---------------------------------------------------------------------------
// b / B — word / WORD start backward (smoke #12 for b)
// ---------------------------------------------------------------------------

describe("b — word start backward", () => {
  vt.each([
    // smoke #12: b from col 4 'b' of "foo bar baz" → col 0 ('f')
    { before: "foo |bar baz", keys: "<Esc>b", after: "|foo bar baz", mode: "normal" },
    // b from '.' in "foo.bar" → 'f' at col 0 (previous keyword word)
    { before: "foo.|bar", keys: "<Esc>b", after: "|foo.bar", mode: "normal",
      name: "b from '.' jumps to start of previous keyword word" },
    // cross-line
    {
      before: "foo\n|bar",
      keys: "<Esc>b",
      after: "|foo\nbar",
      mode: "normal",
      name: "b cross-line to previous word",
    },
    // count: 2b
    { before: "foo bar |baz", keys: "<Esc>2b", after: "|foo bar baz", mode: "normal" },
  ]);
});

describe("B — WORD start backward", () => {
  vt.each([
    { before: "foo.bar |baz", keys: "<Esc>B", after: "|foo.bar baz", mode: "normal" },
  ]);
});

// ---------------------------------------------------------------------------
// e / E — word / WORD end forward (smoke #12 for e)
// ---------------------------------------------------------------------------

describe("e — word end forward", () => {
  vt.each([
    // smoke #12: e from col 0 ('f') on "foo bar baz" → col 2 ('o' = end of "foo")
    { before: "|foo bar baz", keys: "<Esc>e", after: "fo|o bar baz", mode: "normal" },
    // count: 2e
    { before: "|foo bar baz", keys: "<Esc>2e", after: "foo ba|r baz", mode: "normal" },
    // cross-line: cursor on last char of "foo", e moves to "bar" end on next line
    // Seed: "foo|\nbar" → INSERT col 3 (past 'o'), Esc → col 2 ('o' = end of "foo")
    // e from col 2 ('o') in "foo": finds nothing further, crosses to "bar" → col 2 of "bar"
    {
      before: "foo|\nbar",
      keys: "<Esc>e",
      after: "foo\nba|r",
      mode: "normal",
      name: "e cross-line to next word end",
    },
  ]);
});

describe("E — WORD end forward", () => {
  vt.each([
    // WORD ignores punctuation: "foo.bar" is one WORD, E → end of "foo.bar" = col 6 ('r')
    { before: "|foo.bar baz", keys: "<Esc>E", after: "foo.ba|r baz", mode: "normal" },
  ]);
});

// ---------------------------------------------------------------------------
// 0 / ^ / $ — line start / first non-blank / end (smoke #3 for 0)
// ---------------------------------------------------------------------------

describe("0 — line start (smoke #3)", () => {
  vt.each([
    // smoke #3: 0 moves cursor to col 0
    { before: "hell|o", keys: "<Esc>0", after: "|hello", mode: "normal" },
    // already at col 0 — no-op
    { before: "|hello", keys: "<Esc>0", after: "|hello", mode: "normal",
      name: "0 at BOL is idempotent" },
    // multi-char: 0 from middle
    { before: "ab|cdef", keys: "<Esc>0", after: "|abcdef", mode: "normal" },
  ]);
});

describe("^ — first non-blank", () => {
  vt.each([
    // no leading whitespace
    { before: "hel|lo", keys: "<Esc>^", after: "|hello", mode: "normal" },
    // leading spaces: ^ skips them
    // "    hello": spaces at 0-3, 'h' at 4. Seed INSERT at col 8 (past 'o'), Esc → col 7 ('o'? no...)
    // Let's use simple case: seed at col 0, ^ → first non-blank
    { before: "|   hello", keys: "<Esc>^", after: "   |hello", mode: "normal",
      name: "^ skips leading whitespace to first non-blank" },
    // blank line: ^ stays at col 0
    { before: "|", keys: "<Esc>^", after: "|", mode: "normal",
      name: "^ on blank line stays at col 0" },
    // ^ from end of line with leading spaces
    { before: "   hello|", keys: "<Esc>^", after: "   |hello", mode: "normal",
      name: "^ from EOL goes to first non-blank" },
  ]);
});

describe("$ — line end", () => {
  // Implementation: $ calls moveToLineEnd() which places cursor at text.length
  // (one past last char), matching INSERT behaviour, not on the last char.
  vt.each([
    { before: "|hello", keys: "<Esc>$", after: "hello|", mode: "normal" },
    { before: "|abc",   keys: "<Esc>$", after: "abc|",   mode: "normal" },
    // already at EOL (text.length): $ is idempotent
    { before: "|hello", keys: "<Esc>$$", after: "hello|", mode: "normal",
      name: "$ twice is idempotent" },
    // empty line — stays at col 0
    { before: "|", keys: "<Esc>$", after: "|", mode: "normal",
      name: "$ on empty line stays at 0" },
  ]);
});

// ---------------------------------------------------------------------------
// { / } — paragraph motions (PARAGRAPHS fixture: "a\nb\n\nc\nd\n\ne")
// ---------------------------------------------------------------------------
// PARAGRAPHS = "a\nb\n\nc\nd\n\ne"
// Lines: 0=a, 1=b, 2=blank, 3=c, 4=d, 5=blank, 6=e
// isParagraphStart: line 0 (a), line 3 (c after blank), line 6 (e after blank)

describe("} — paragraph forward", () => {
  vt.each([
    // } from line 0 ("a") → next paragraph start = line 3 ("c")
    {
      before: "|a\nb\n\nc\nd\n\ne",
      keys: "<Esc>}",
      after: "a\nb\n\n|c\nd\n\ne",
      mode: "normal",
      name: "} moves to next paragraph start",
    },
    // 2} from line 0 → skip to line 3 then line 6
    {
      before: "|a\nb\n\nc\nd\n\ne",
      keys: "<Esc>2}",
      after: "a\nb\n\nc\nd\n\n|e",
      mode: "normal",
      name: "2} skips two paragraphs",
    },
    // from line 3 "c", } → line 6 "e"
    {
      before: "a\nb\n\n|c\nd\n\ne",
      keys: "<Esc>}",
      after: "a\nb\n\nc\nd\n\n|e",
      mode: "normal",
    },
    // at last paragraph — no more paragraph start found, stays at last line
    {
      before: "a\nb\n\nc\nd\n\n|e",
      keys: "<Esc>}",
      after: "a\nb\n\nc\nd\n\n|e",
      mode: "normal",
      name: "} at last paragraph is a no-op",
    },
  ]);
});

describe("{ — paragraph backward", () => {
  vt.each([
    // from line 3 ("c"), { → line 0 ("a")
    {
      before: "a\nb\n\n|c\nd\n\ne",
      keys: "<Esc>{",
      after: "|a\nb\n\nc\nd\n\ne",
      mode: "normal",
      name: "{ moves to previous paragraph start",
    },
    // from line 6 ("e"), { → line 3 ("c")
    {
      before: "a\nb\n\nc\nd\n\n|e",
      keys: "<Esc>{",
      after: "a\nb\n\n|c\nd\n\ne",
      mode: "normal",
    },
    // 2{ from line 6 → line 3 then line 0
    {
      before: "a\nb\n\nc\nd\n\n|e",
      keys: "<Esc>2{",
      after: "|a\nb\n\nc\nd\n\ne",
      mode: "normal",
      name: "2{ skips two paragraphs backward",
    },
    // at first paragraph — stays
    {
      before: "|a\nb\n\nc\nd\n\ne",
      keys: "<Esc>{",
      after: "|a\nb\n\nc\nd\n\ne",
      mode: "normal",
      name: "{ at first paragraph is a no-op",
    },
  ]);
});

// ---------------------------------------------------------------------------
// f / F / t / T — char-find; ; / , — repeat (smoke #14, #15)
// ---------------------------------------------------------------------------

describe("f — find char forward (smoke #14 context)", () => {
  vt.each([
    // f finds a char on the current line
    // "a.b.c.d": f. from col 0 → col 1 (first '.')
    { before: "|a.b.c.d", keys: "<Esc>f.", after: "a|.b.c.d", mode: "normal" },
    // f from col 0 on "abcdef": fd → col 3
    { before: "|abcdef", keys: "<Esc>fd", after: "abc|def", mode: "normal" },
    // not-found is no-op (cursor stays at col 0 after Esc)
    { before: "|abcdef", keys: "<Esc>fz", after: "|abcdef", mode: "normal",
      name: "f not-found is a no-op" },
    // count: 2f. on "a.b.c" → second '.' at col 3
    // "a.b.c": a(0).(1)b(2).(3)c(4). 2f. from col 0 → col 3.
    { before: "|a.b.c", keys: "<Esc>2f.", after: "a.b|.c", mode: "normal",
      name: "2f. finds second occurrence" },
  ]);
});

describe("F — find char backward", () => {
  vt.each([
    // Fa from col 3 ('b') in "abcba": finds 'a' at col 0
    // Seed "abc|ba" → INSERT col 3, Esc → col 2 ('c'), Fa → col 0
    // Wait: "abc|ba" → INSERT col 3. Esc → col 2. 'c' at col 2, Fa from col 2: 'b' at 1, 'a' at 0. → col 0.
    { before: "abc|ba", keys: "<Esc>Fa", after: "|abcba", mode: "normal" },
    // F. from end: "a.b.c" from col 4 ('c'): F. → col 3 ('.')
    // Seed "a.b.c|" → INSERT col 5 (past 'c'), Esc → col 4 ('c'), F. → col 3
    { before: "a.b.c|", keys: "<Esc>F.", after: "a.b|.c", mode: "normal" },
    // not-found: cursor stays where Esc left it (col 0)
    { before: "|abcdef", keys: "<Esc>Fz", after: "|abcdef", mode: "normal",
      name: "F not-found is a no-op" },
  ]);
});

describe("t — till char forward (smoke #15 context)", () => {
  vt.each([
    // t from col 0 on "abcde": tc → stop before 'c' = col 1 ('b')
    { before: "|abcde", keys: "<Esc>tc", after: "a|bcde", mode: "normal",
      name: "t stops one before the target char" },
    // not-found is no-op
    { before: "|abcde", keys: "<Esc>tz", after: "|abcde", mode: "normal",
      name: "t not-found is a no-op" },
    // t. on "a.b.c.d" from col 0: first '.' at col 1, t stops at col 0 (already before it)
    // Then ; repeats: skips first '.' position, finds second '.' at col 3, stops at col 2 ('b')
    { before: "|a.b.c.d", keys: "<Esc>t.", after: "|a.b.c.d", mode: "normal",
      name: "t when cursor is just before target lands at current col (smoke #15 setup)" },
  ]);
});

describe("T — till char backward", () => {
  vt.each([
    // "abcde", Tc from col 4 ('e'): stop after 'c' = col 3 ('d')
    // Seed "abcde|" → INSERT col 5, Esc → col 4 ('e'), Tc → col 3
    { before: "abcde|", keys: "<Esc>Tc", after: "abc|de", mode: "normal",
      name: "T stops one after the target char (backward)" },
    // not-found: stays at current col (col 0 after Esc)
    { before: "|abcde", keys: "<Esc>Tz", after: "|abcde", mode: "normal",
      name: "T not-found is a no-op" },
  ]);
});

describe("; — repeat last char-find (smoke #15)", () => {
  vt.each([
    // smoke #15: t. on "a.b.c.d" from col 0 → col 0 (already before first '.').
    // ; repeats with tillRepeatOffset=1: skips from col 0+1+1=2, finds '.' at col 3,
    // stops before it → col 2 ('b').
    {
      before: "|a.b.c.d",
      keys: "<Esc>t.;",
      after: "a.|b.c.d",
      mode: "normal",
      name: "; after t. advances past first '.' and stops before second '.'",
    },
    // f then ;: fa on "abcba" from col 0 → col 1 ('b')... wait 'a' is col 0, fa finds 'a'
    // after col 0. "abcba": a(0)b(1)c(2)b(3)a(4). fa from col 0 → col 4 ('a'? no):
    // f searches from col+1 = 1 forward. grapheme[1]='b', [2]='c', [3]='b', [4]='a'. Found 'a' at index 4. → col 4.
    // Then ; repeats fa from col 4: searches from col 5 forward, none found → no-op. Stays at col 4.
    // state: "abcb|a" (col 4).
    { before: "|abcba", keys: "<Esc>fa;", after: "abcb|a", mode: "normal",
      name: "; repeats f (then no-op on second ;)" },
    // ; is no-op when no prior find
    { before: "|abcde", keys: "<Esc>;", after: "|abcde", mode: "normal",
      name: "; with no prior find is a no-op" },
  ]);
});

describe(", — reverse repeat last char-find", () => {
  vt.each([
    // f. on "a.b.c" from col 0 → col 1 (first '.').
    // Then f. again from col 1 → col 3 (second '.').
    // Then , (reverse: F. from col 3): finds previous '.' at col 1.
    { before: "|a.b.c", keys: "<Esc>f.f.,", after: "a|.b.c", mode: "normal",
      name: ", reverses last f to go backward" },
    // Fb from col 3 in "abcba" (seed: "abcb|a" → INSERT col 4, Esc → col 3 'b'):
    // Fb: backward 'b' from col 3. 'b' at col 1. → col 1.
    // , (reverse of F = f): forward 'b' from col 1. 'b' at col 3 → col 3.
    { before: "abcb|a", keys: "<Esc>Fb,", after: "abc|ba", mode: "normal",
      name: ", after F moves forward (reversal)" },
  ]);
});

// ---------------------------------------------------------------------------
// % — jump to matching bracket (smoke #21)
// ---------------------------------------------------------------------------

describe("% — matching bracket (smoke #21)", () => {
  vt.each([
    // smoke #21: "x(y)z", cursor on '(' → jump to ')'
    // Seed "x|(y)z" → INSERT col 1, Esc → col 0 ('x'). Need to be on '('.
    // Seed "x(|y)z" → INSERT col 2, Esc → col 1 ('('). % → col 3 ')'.
    { before: "x(|y)z", keys: "<Esc>%", after: "x(y|)z", mode: "normal",
      name: "% ( -> )" },
    // from ')' → '('
    { before: "x(y|)z", keys: "<Esc>%", after: "x|(y)z", mode: "normal",
      name: "% ) -> (" },
    // cursor on '[' → ']'
    { before: "foo(bar[|baz]qux)end", keys: "<Esc>%", after: "foo(bar[baz|]qux)end", mode: "normal",
      name: "% [ -> ]" },
    // cursor on ']' → '['
    { before: "foo(bar[baz|]qux)end", keys: "<Esc>%", after: "foo(bar|[baz]qux)end", mode: "normal",
      name: "% ] -> [" },
    // on non-bracket — no-op (cursor stays at col 0)
    { before: "|hello world", keys: "<Esc>%", after: "|hello world", mode: "normal",
      name: "% on non-bracket is a no-op" },
    // % when not on a bracket scans forward on current line to find the first bracket
    // "foo(bar)": f(0)o(1)o(2)((3)... from col 0, scan forward, finds '(' at col 3, jumps to ')' at col 7.
    { before: "|foo(bar)end", keys: "<Esc>%", after: "foo(bar|)end", mode: "normal",
      name: "% on non-bracket scans right on line for first bracket" },
  ]);
});

// ---------------------------------------------------------------------------
// gg / G / {count}gg / {count}G — buffer jumps (smoke #18)
// ---------------------------------------------------------------------------

describe("gg — jump to first line (smoke #18)", () => {
  vt.each([
    // smoke #18: gg from last line → line 0
    {
      before: "one\ntwo\n|three",
      keys: "<Esc>gg",
      after: "|one\ntwo\nthree",
      mode: "normal",
      name: "gg goes to line 0 first non-blank",
    },
    // gg from middle line
    {
      before: "one\n|two\nthree",
      keys: "<Esc>gg",
      after: "|one\ntwo\nthree",
      mode: "normal",
    },
    // already on line 0 — idempotent
    {
      before: "|one\ntwo",
      keys: "<Esc>gg",
      after: "|one\ntwo",
      mode: "normal",
      name: "gg on first line is idempotent",
    },
    // gg lands on first non-blank (indented first line)
    {
      before: "one\ntwo\n|three",
      keys: "<Esc>gg",
      after: "|one\ntwo\nthree",
      mode: "normal",
      name: "gg first-non-blank on first line",
    },
  ]);
});

describe("G — jump to last line (smoke #18)", () => {
  vt.each([
    // smoke #18: G from line 0 → last line
    {
      before: "|one\ntwo\nthree",
      keys: "<Esc>G",
      after: "one\ntwo\n|three",
      mode: "normal",
      name: "G goes to last line",
    },
    // single-line buffer — stays
    {
      before: "|hello",
      keys: "<Esc>G",
      after: "|hello",
      mode: "normal",
      name: "G on single-line buffer is idempotent",
    },
    // G lands on first non-blank of last line
    {
      before: "|one\ntwo\n   three",
      keys: "<Esc>G",
      after: "one\ntwo\n   |three",
      mode: "normal",
      name: "G lands on first non-blank of last line",
    },
  ]);
});

describe("{count}G — absolute line jump", () => {
  vt.each([
    // 2G → line 1 (1-indexed)
    {
      before: "|one\ntwo\nthree",
      keys: "<Esc>2G",
      after: "one\n|two\nthree",
      mode: "normal",
      name: "2G jumps to line 2 (1-indexed)",
    },
    // 1G → line 0 (same as gg)
    {
      before: "one\ntwo\n|three",
      keys: "<Esc>1G",
      after: "|one\ntwo\nthree",
      mode: "normal",
      name: "1G is same as gg",
    },
    // count beyond last line clamps at last
    {
      before: "|one\ntwo",
      keys: "<Esc>99G",
      after: "one\n|two",
      mode: "normal",
      name: "large countG clamps at last line",
    },
    // G lands on first non-blank of target line
    {
      before: "|one\n   two\nthree",
      keys: "<Esc>2G",
      after: "one\n   |two\nthree",
      mode: "normal",
      name: "{count}G lands on first non-blank of target line",
    },
  ]);
});

describe("{count}gg — absolute line jump via gg", () => {
  vt.each([
    // 2gg → line 1 (1-indexed)
    {
      before: "one\ntwo\n|three",
      keys: "<Esc>2gg",
      after: "one\n|two\nthree",
      mode: "normal",
      name: "2gg jumps to line 2 (1-indexed)",
    },
    // 3gg → line 2 (last line in a 3-line buffer)
    {
      before: "|one\ntwo\nthree",
      keys: "<Esc>3gg",
      after: "one\ntwo\n|three",
      mode: "normal",
      name: "3gg jumps to last line",
    },
  ]);
});

// ---------------------------------------------------------------------------
// Compound: multi-motion sequences
// ---------------------------------------------------------------------------

describe("combined motions — independence", () => {
  vt.each([
    // 3l then h: from col 0, 3l → col 3, h → col 2
    {
      before: "|abcde",
      keys: "<Esc>3lh",
      after: "ab|cde",
      mode: "normal",
      name: "3l then h: ends at col 2",
    },
    // gg then G on two-line buffer ends at last line
    {
      before: "|first\nsecond",
      keys: "<Esc>ggG",
      after: "first\n|second",
      mode: "normal",
      name: "gg then G ends at last line",
    },
    // w then b returns to same word start
    {
      before: "|foo bar",
      keys: "<Esc>wb",
      after: "|foo bar",
      mode: "normal",
      name: "w then b returns to same word start",
    },
    // 0 then $: from col 0 on "hello", 0 stays at col 0, $ goes to col 5
    {
      before: "|hello",
      keys: "<Esc>0$",
      after: "hello|",
      mode: "normal",
      name: "0 then $ ends at EOL",
    },
  ]);
});

// ---------------------------------------------------------------------------
// Edge: single char / empty buffer
// ---------------------------------------------------------------------------

describe("motions on minimal buffers", () => {
  vt.each([
    // h on single char (col 0 → no change)
    { before: "|a", keys: "<Esc>h", after: "|a", mode: "normal",
      name: "h on single char is a no-op" },
    // $ on single char → col 1 (past 'a')
    { before: "|a", keys: "<Esc>$", after: "a|", mode: "normal",
      name: "$ on single char goes to col 1" },
    // 0 on empty buffer
    { before: "|", keys: "<Esc>0", after: "|", mode: "normal",
      name: "0 on empty buffer is a no-op" },
    // $ on empty line — stays at col 0
    { before: "|", keys: "<Esc>$", after: "|", mode: "normal",
      name: "$ on empty buffer stays at col 0" },
    // w on single char: no next word on line, no next line → col = cur.length (text.length)
    { before: "|a", keys: "<Esc>w", after: "a|", mode: "normal",
      name: "w on single char moves to col text.length" },
  ]);
});

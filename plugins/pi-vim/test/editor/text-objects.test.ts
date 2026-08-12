/**
 * test/editor/text-objects.test.ts
 *
 * Text-object integration tests through the modal editor.
 * Covers `i`/`a` variants under `d`, `c`, and `y` operators for:
 *   w W     — inner word / a word (incl. trailing whitespace)
 *   " ' `   — quote pairs
 *   ( ) b   — parentheses (b is alias for ()
 *   [ ]     — square brackets
 *   { } B   — curly braces (B is alias for {})
 *
 * Cursor convention: `seed("text |here")` places the INSERT-mode cursor at col 5.
 * The first key in every case is `<Esc>`, which moves the cursor LEFT ONE, landing
 * on col 4 in NORMAL. All `before` strings are designed with this offset in mind.
 *
 * Behavioral oracle: smoke.ts checks 16 (ci") and 17 (di().
 */

import { describe, vt } from "../support/harness.ts";

// ---------------------------------------------------------------------------
// 1. Word objects — iw / aw / iW / aW
// ---------------------------------------------------------------------------

describe("ciw — change inner word", () => {
  vt.each([
    // Seed cursor right of word start so after Esc it lands on first char.
    // "hello world": cursor seeded at col 2 (e), Esc → col 1 = 'e'; ciw selects "hello".
    // But wait: in "hello world" the whole word "hello" runs 0-4. After ciw,
    // text = " world" and cursor is at abs 0 = ' '. Simpler: cursor inside word.
    {
      // Seed at col 2 ('e'→Esc→col 1='e'). ciw selects "hello"→delete→" world", cursor at 0.
      before: "h|ello world",
      keys: "<Esc>ciw",
      after: "| world",
      mode: "insert",
      name: "ciw from first char of word deletes word, enters INSERT",
    },
    {
      // Seed cursor inside 'hello'. Esc→col 1='e'. ciw deletes "hello".
      before: "he|llo world",
      keys: "<Esc>ciw",
      after: "| world",
      mode: "insert",
      name: "ciw from word middle deletes whole word",
    },
    {
      // Seed at 'r' end of 'bar'. Esc→col 6='r'. ciw deletes "bar".
      // "foo bar": f=0,o=1,o=2,' '=3,b=4,a=5,r=6. After deleting [4,7]: "foo " cursor at 4.
      before: "foo ba|r",
      keys: "<Esc>ciw",
      after: "foo |",
      mode: "insert",
      name: "ciw on last word (no trailing space) deletes it, enters INSERT",
    },
  ]);
});

describe("daw — delete a word (incl. trailing whitespace)", () => {
  vt.each([
    // daw on a word with trailing space eats the word + trailing space.
    // "foo bar baz": cursor at 'b'(col 4) after Esc from col 5. daw: "bar "=[4,8]. → "foo baz", cursor at 4.
    {
      before: "foo b|ar baz",
      keys: "<Esc>daw",
      after: "foo |baz",
      mode: "normal",
      name: "daw on non-final word deletes word + trailing space",
    },
    // daw on last word — no trailing whitespace → eat leading whitespace instead.
    // "foo bar": range=[3,7] → "foo". cursor placed at abs 3 (at EOF marker).
    {
      before: "foo b|ar",
      keys: "<Esc>daw",
      after: "foo|",
      mode: "normal",
      name: "daw on last word eats leading space instead",
    },
  ]);
});

describe("diW — delete inner WORD (whitespace-delimited)", () => {
  vt.each([
    // WORD (W) treats all non-blank as one class, so "foo.bar" is one WORD.
    // "foo.bar baz": cursor at 'b'(col 4) after Esc from col 5.
    // WORD run for col 4 extends to include all of "foo.bar" = [0,7]. Delete → " baz" cursor at 0.
    {
      before: "foo.b|ar baz",
      keys: "<Esc>diW",
      after: "| baz",
      mode: "normal",
      name: "diW treats foo.bar as one WORD (punctuation not a break)",
    },
    // Show '!' stays in the same WORD as the letters: "world!" is one W unit.
    // "world!": cursor at '!'(col 5) after Esc from col 6. diW: WORD = [0,6]. Delete → "", cursor at 0.
    {
      before: "world!|",
      keys: "<Esc>diW",
      after: "|",
      mode: "normal",
      name: "diW: world! treated as one WORD (! not a break)",
    },
  ]);
});

describe("daW — delete a WORD incl. trailing whitespace", () => {
  vt.each([
    // "foo.bar baz": cursor at 'b'(col 4) after Esc. daW: WORD "foo.bar" + trailing ' ' = [0,8]. → "baz" cursor at 0.
    {
      before: "foo.b|ar baz",
      keys: "<Esc>daW",
      after: "|baz",
      mode: "normal",
      name: "daW deletes WORD including trailing space",
    },
  ]);
});

// ---------------------------------------------------------------------------
// 2. Quote objects — " ' `
// ---------------------------------------------------------------------------

// Reference: smoke.ts check 16 verifies ci" changes inside quotes.
describe('ci" — change inside double quotes', () => {
  vt.each([
    // Cursor inside "hi": 'say "hi" ok', quotes at col 4 and 7.
    // Seed: "say "h|i" ok" → cursor at col 6('i') → Esc → col 5('h'). 4<=5<=7 ✓.
    // inner range [5,7]="hi". Delete → 'say "" ok' cursor at col 5='"'. Mode=INSERT.
    {
      before: 'say "h|i" ok',
      keys: '<Esc>ci"',
      after: 'say "|" ok',
      mode: "insert",
      name: 'ci" from cursor inside quotes deletes content and enters INSERT',
    },
    // Cursor on the opening quote: Esc lands on '"' at col 4. resolveQuoteObject
    // checks openIndex<=cursor<=closeIndex → 4<=4<=7 ✓. Same result.
    {
      // Seed at col 5 ('h') → Esc → col 4 = '"' (opening quote).
      before: 'say "|hi" ok',
      keys: '<Esc>ci"',
      after: 'say "|" ok',
      mode: "insert",
      name: 'ci" with cursor on opening quote still matches the pair',
    },
    // Cursor on closing quote: "say "hi|" ok" → Esc → col 6 = 'i'.
    // Same inner range, same result.
    {
      before: 'say "hi|" ok',
      keys: '<Esc>ci"',
      after: 'say "|" ok',
      mode: "insert",
      name: 'ci" with cursor on char before closing quote',
    },
  ]);
});

describe('di" — delete inside double quotes', () => {
  vt.each([
    // '"hello"': quotes at 0 and 6. Cursor at col 3 (l) after Esc from col 4.
    // inner range [1,6]="hello". Delete → '""' cursor at abs 1='"'. State = '"|"'.
    {
      before: '"hel|lo"',
      keys: '<Esc>di"',
      after: '"|"',
      mode: "normal",
      name: 'di" empties quoted string',
    },
    // Select the correct pair when two exist: cursor inside "bar" picks [15,19].
    // 'first "foo" and "bar"': f(0)i(1)r(2)s(3)t(4) (5)"(6)f(7)o(8)o(9)"(10) (11)a(12)n(13)d(14) (15)"(16)b(17)a(18)r(19)"(20)
    // Pairs: [6,10] and [16,20]. Seed cursor at col 19 (r) → Esc → col 18 = 'a'. 16<=18<=20 ✓.
    // inner range [17,20]="bar". Delete → 'first "foo" and ""' cursor at abs 17 = '"'.
    {
      before: 'first "foo" and "ba|r"',
      keys: '<Esc>di"',
      after: 'first "foo" and "|"',
      mode: "normal",
      name: 'di" with two pairs selects the pair containing the cursor',
    },
  ]);
});

describe("ci' — change inside single quotes", () => {
  vt.each([
    // "say 'hi' there": '(4), h(5), i(6), '(7). Cursor at col 6('i') after Esc from col 7.
    // pair [4,7]. inner [5,7]="hi". Delete → "say '' there" cursor at col 5. Mode=INSERT.
    {
      before: "say 'hi|' there",
      keys: "<Esc>ci'",
      after: "say '|' there",
      mode: "insert",
      name: "ci' changes content inside single quotes",
    },
    // Empty pair: ci' on '' — inner range [1,1] is empty; deleteAbsRange no-ops; enters INSERT.
    // Seed "|''" → Esc → cursor stays col 0 (can't go below 0). Mode INSERT at col 0.
    {
      before: "|''",
      keys: "<Esc>ci'",
      after: "|''",
      mode: "insert",
      name: "ci' on empty pair enters INSERT (nothing deleted)",
    },
  ]);
});

describe("di` — delete inside backticks", () => {
  vt.each([
    // "run `code` here": `(4), c(5), o(6), d(7), e(8), `(9). Cursor at col 8('e') after Esc.
    // pair [4,9]. inner [5,9]="code". Delete → "run `` here" cursor at col 5="`".
    {
      before: "run `co|de` here",
      keys: "<Esc>di`",
      after: "run `|` here",
      mode: "normal",
      name: "di` removes content inside backticks",
    },
  ]);
});

describe('da" — delete a double-quoted pair (incl. quotes)', () => {
  vt.each([
    // 'say "hello" there': "(4), h(5)..o(9), "(10). Outer range (da) = [4,11].
    // Seed: 'say "|hello" there' → cursor at col 5('h') → Esc → col 4='"'.
    // pair [4,10]. outer range [4,11]. Delete → "say  there" cursor at abs 4=' '. State = "say | there".
    {
      before: 'say "|hello" there',
      keys: '<Esc>da"',
      after: "say | there",
      mode: "normal",
      name: 'da" deletes including the quote characters',
    },
  ]);
});

// ---------------------------------------------------------------------------
// 3. Bracket / paren objects — ( ) b
// ---------------------------------------------------------------------------

// Reference: smoke.ts check 17 verifies di( empties parens.
describe("di( — delete inside parens", () => {
  vt.each([
    // "f(a, b)": (=1, a=2, ,=3, ' '=4, b=5, )=6.
    // Seed "f(a, |b)" → cursor at col 5('b') → Esc → col 4=' '. 1<=4<=6 ✓.
    // inner range [2,6]="a, b". Delete → "f()" cursor at abs 2=')'. State = "f(|)".
    {
      before: "f(a, |b)",
      keys: "<Esc>di(",
      after: "f(|)",
      mode: "normal",
      name: "di( empties parens; cursor lands on close paren",
    },
    // di) is alias for di(
    {
      before: "f(a, |b)",
      keys: "<Esc>di)",
      after: "f(|)",
      mode: "normal",
      name: "di) is alias for di(",
    },
    // dib is alias for di(
    {
      before: "f(a, |b)",
      keys: "<Esc>dib",
      after: "f(|)",
      mode: "normal",
      name: "dib is alias for di(",
    },
  ]);
});

describe("da( — delete a paren pair (incl. parens)", () => {
  vt.each([
    // "f(a, b) end": Seed "f(|a, b) end" → col 2 → Esc → col 1='('. outer range [1,7].
    // Delete → "f end" cursor at abs 1=' '. State = "f| end".
    {
      before: "f(|a, b) end",
      keys: "<Esc>da(",
      after: "f| end",
      mode: "normal",
      name: "da( deletes parens and content",
    },
    // da) alias
    {
      before: "f(|a, b) end",
      keys: "<Esc>da)",
      after: "f| end",
      mode: "normal",
      name: "da) is alias for da(",
    },
  ]);
});

describe("ci( — change inside parens", () => {
  vt.each([
    // "call(args)": (=4, a=5..s=8, )=9. Seed "call(ar|gs)" → col 7 → Esc → col 6='g'.
    // 4<=6<=9 ✓. inner range [5,9]="args". Delete → "call()" cursor at col 5. Mode=INSERT.
    {
      before: "call(ar|gs)",
      keys: "<Esc>ci(",
      after: "call(|)",
      mode: "insert",
      name: "ci( deletes content and enters INSERT inside parens",
    },
    // cib alias
    {
      before: "call(ar|gs)",
      keys: "<Esc>cib",
      after: "call(|)",
      mode: "insert",
      name: "cib is alias for ci(",
    },
  ]);
});

// ---------------------------------------------------------------------------
// 4. Square bracket objects — [ ]
// ---------------------------------------------------------------------------

describe("di[ — delete inside square brackets", () => {
  vt.each([
    // "arr[1, 2, 3]": [=3, 1=4..3=9, ]=10. Seed "arr[1, |2, 3]" → col 7 → Esc → col 6=' '.
    // 3<=6<=10 ✓. inner range [4,10]. Delete → "arr[]" cursor at col 4=']'. State = "arr[|]".
    {
      before: "arr[1, |2, 3]",
      keys: "<Esc>di[",
      after: "arr[|]",
      mode: "normal",
      name: "di[ empties brackets",
    },
    // di] is alias for di[
    {
      before: "arr[1, |2, 3]",
      keys: "<Esc>di]",
      after: "arr[|]",
      mode: "normal",
      name: "di] is alias for di[",
    },
  ]);
});

describe("yi[ — yank inside square brackets", () => {
  vt.each([
    // yi[ yanks the inner content and parks cursor at the range start (the 'a').
    // "arr[abc]": [=3, a=4, b=5, c=6, ]=7. Seed "arr[a|bc]" → col 5 → Esc → col 4='a'. 3<=4<=7 ✓.
    // inner range [4,7]="abc". Yank. Park at abs 4='a'. State = "arr[|abc]".
    {
      before: "arr[a|bc]",
      keys: "<Esc>yi[",
      after: "arr[|abc]",
      mode: "normal",
      name: "yi[ yanks inner content and parks cursor at range start",
    },
  ]);
});

describe("da[ — delete a square-bracket pair", () => {
  vt.each([
    // "arr[1, 2] end": [=3, ]=8. Seed "arr[1, |2] end" → col 7 → Esc → col 6=' '.
    // 3<=6<=8 ✓. outer range [3,9]. Delete → "arr end" cursor at abs 3=' '. State = "arr| end".
    {
      before: "arr[1, |2] end",
      keys: "<Esc>da[",
      after: "arr| end",
      mode: "normal",
      name: "da[ deletes brackets and content",
    },
  ]);
});

// ---------------------------------------------------------------------------
// 5. Curly brace objects — { } B
// ---------------------------------------------------------------------------

describe("da{ — delete a curly-brace pair", () => {
  vt.each([
    // "obj{key: val} end": {=3, }=12. Seed "obj{key|: val} end" → col 7 → Esc → col 6=' '.
    // 3<=6<=12 ✓. outer range [3,13]. Delete → "obj end" cursor at abs 3=' '. State = "obj| end".
    {
      before: "obj{key|: val} end",
      keys: "<Esc>da{",
      after: "obj| end",
      mode: "normal",
      name: "da{ deletes braces and content",
    },
    // daB alias
    {
      before: "obj{key|: val} end",
      keys: "<Esc>daB",
      after: "obj| end",
      mode: "normal",
      name: "daB is alias for da{",
    },
  ]);
});

describe("di{ — delete inside curly braces", () => {
  vt.each([
    // "{x: 1}": {=0, x=1..1=4, }=5. Seed "{x: |1}" → col 4 → Esc → col 3=':'. 0<=3<=5 ✓.
    // inner range [1,5]="x: 1". Delete → "{}" cursor at col 1='}'. State = "{|}".
    {
      before: "{x: |1}",
      keys: "<Esc>di{",
      after: "{|}",
      mode: "normal",
      name: "di{ empties braces",
    },
    // di} alias
    {
      before: "{x: |1}",
      keys: "<Esc>di}",
      after: "{|}",
      mode: "normal",
      name: "di} is alias for di{",
    },
    // diB alias
    {
      before: "{x: |1}",
      keys: "<Esc>diB",
      after: "{|}",
      mode: "normal",
      name: "diB is alias for di{",
    },
  ]);
});

describe("ci{ — change inside curly braces", () => {
  vt.each([
    // "{body}": {=0, b=1..y=4, }=5. Seed "{bo|dy}" → col 3 → Esc → col 2='o'. 0<=2<=5 ✓.
    // inner range [1,5]="body". Delete → "{}" cursor at col 1. Mode=INSERT.
    {
      before: "{bo|dy}",
      keys: "<Esc>ci{",
      after: "{|}",
      mode: "insert",
      name: "ci{ empties braces and enters INSERT",
    },
  ]);
});

// ---------------------------------------------------------------------------
// 6. Nested pairs — bracket objects use stack-based nesting; innermost wins
// ---------------------------------------------------------------------------

describe("nested bracket pairs — innermost enclosing pair is resolved", () => {
  // BRACKETS = "foo(bar[baz]qux)end"
  // (=3, b=4,a=5,r=6, [=7, b=8,a=9,z=10, ]=11, q=12,u=13,x=14, )=15

  vt.each([
    // Cursor inside [baz]: di[ resolves innermost [] even though we're also inside ().
    // Seed "foo(bar[|baz]qux)end" → cursor at col 8 → Esc → col 7='['. 7<=7<=11 ✓.
    // inner range [8,11]="baz". Delete → "foo(bar[]qux)end" cursor at col 8=']'. State = "foo(bar[|]qux)end".
    {
      before: "foo(bar[|baz]qux)end",
      keys: "<Esc>di[",
      after: "foo(bar[|]qux)end",
      mode: "normal",
      name: "di[ resolves innermost [] even when inside outer ()",
    },
    // Cursor inside [baz]: di( takes the OUTER () pair since [] is a different delimiter.
    // Seed "foo(bar[b|az]qux)end" → cursor at col 9 → Esc → col 8='b'. 3<=8<=15 ✓.
    // inner range [4,15]="bar[baz]qux". Delete → "foo()end" cursor at col 4=')'. State = "foo(|)end".
    {
      before: "foo(bar[b|az]qux)end",
      keys: "<Esc>di(",
      after: "foo(|)end",
      mode: "normal",
      name: "di( from inside inner [] still resolves the outer () pair",
    },
    // da[ eats inner [] and their delimiters.
    // Seed "foo(bar[|baz]qux)end" → Esc → col 7='['. outer range [7,12]="[baz]".
    // Delete → "foo(barqux)end" cursor at col 7='q'. State = "foo(bar|qux)end".
    {
      before: "foo(bar[|baz]qux)end",
      keys: "<Esc>da[",
      after: "foo(bar|qux)end",
      mode: "normal",
      name: "da[ deletes inner [] and content",
    },
  ]);
});

// ---------------------------------------------------------------------------
// 7. y variants — buffer unchanged, cursor parks at object start
// ---------------------------------------------------------------------------

describe("yiw — yank inner word; cursor parks at word start", () => {
  vt.each([
    // Seed with cursor inside 'bar': "foo b|ar baz" → Esc → col 4='b'. yiw: word "bar"=[4,7].
    // Park at abs 4. Buffer unchanged. State = "foo |bar baz".
    {
      before: "foo b|ar baz",
      keys: "<Esc>yiw",
      after: "foo |bar baz",
      mode: "normal",
      name: "yiw on word start: buffer unchanged, cursor parks at word start",
    },
    // Cursor in middle of word: should still park at start of that word.
    // "foo bar baz": Seed "foo ba|r baz" → Esc → col 5='a'. yiw: "bar" starts at col 4.
    // Park at abs 4. State = "foo |bar baz".
    {
      before: "foo ba|r baz",
      keys: "<Esc>yiw",
      after: "foo |bar baz",
      mode: "normal",
      name: "yiw from word middle parks cursor at word start",
    },
  ]);
});

describe('yi" — yank inside double quotes; cursor parks at content start', () => {
  vt.each([
    // '"hello"': "(0), h(1)..o(5), "(6). Seed '"hel|lo"' → col 4 → Esc → col 3='l'.
    // pair [0,6]. inner [1,6]="hello". Park at abs 1='h'. State = '"|hello"'.
    {
      before: '"hel|lo"',
      keys: '<Esc>yi"',
      after: '"|hello"',
      mode: "normal",
      name: 'yi" parks cursor at start of quoted content',
    },
  ]);
});

describe("yi( — yank inside parens; cursor parks at content start", () => {
  vt.each([
    // "f(a, b)": Seed "f(a, |b)" → col 5 → Esc → col 4=' '. 1<=4<=6 ✓. inner [2,6].
    // Park at abs 2='a'. State = "f(|a, b)".
    {
      before: "f(a, |b)",
      keys: "<Esc>yi(",
      after: "f(|a, b)",
      mode: "normal",
      name: "yi( parks cursor at start of inner paren content",
    },
  ]);
});

// ---------------------------------------------------------------------------
// 8. No-match (cursor outside any pair) — no-op; buffer and mode unchanged
// ---------------------------------------------------------------------------

describe("text object on unmatched delimiter — no-op", () => {
  vt.each([
    // di( on a line with no parens: after Esc cursor shifts one left, text unchanged.
    // "no parens here": Seed "no parens |here" → cursor col 10 → Esc → col 9='e'.
    // di( finds no pair → reset pending, stay NORMAL. State = "no parens| here".
    {
      before: "no parens |here",
      keys: "<Esc>di(",
      after: "no parens| here",
      mode: "normal",
      name: "di( on line without parens is a no-op (buffer unchanged)",
    },
    // di" on a line with no quotes.
    // "no quotes here": Seed "no quotes |here" → Esc → col 9='e'. State = "no quotes| here".
    {
      before: "no quotes |here",
      keys: '<Esc>di"',
      after: "no quotes| here",
      mode: "normal",
      name: 'di" on line without quotes is a no-op',
    },
    // di{ when cursor is BEFORE the open brace (not inside the pair).
    // "pre {body}": {=4. Seed "pre |{body}" → cursor col 4 (on '{') → Esc → col 3=' '.
    // resolveBracketObjectRange: pair [4,9]. Is 4<=3<=9? No → null → no-op.
    {
      before: "pre |{body}",
      keys: "<Esc>di{",
      after: "pre| {body}",
      mode: "normal",
      name: "di{ when cursor is before the open brace is a no-op",
    },
    // ci" on a line without quotes: no-op, stays NORMAL (does NOT enter INSERT).
    // "plain text": Seed "plain |text" → cursor col 6 → Esc → col 5='x'. ci": no quotes → no-op.
    {
      before: "plain |text",
      keys: '<Esc>ci"',
      after: "plain| text",
      mode: "normal",
      name: 'ci" on line without quotes is a no-op (stays NORMAL)',
    },
  ]);
});

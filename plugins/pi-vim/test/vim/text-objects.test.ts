import { describe, expect, test } from "bun:test";
import {
  normalizeDelimiterKey,
  isEscapedDelimiter,
  resolveDelimitedTextObjectRange,
  resolveMatchingPairMotionTarget,
  resolveWordTextObjectRange,
  resolveQuoteObjectRange,
  resolveBracketObjectRange,
  type DelimiterSpec,
} from "../../src/vim/text-objects.ts";

// ---------------------------------------------------------------------------
// normalizeDelimiterKey
// ---------------------------------------------------------------------------

describe("normalizeDelimiterKey", () => {
  test.each<[string, DelimiterSpec | null]>([
    ['"',  { type: "quote",   open: '"',  close: '"'  }],
    ["'",  { type: "quote",   open: "'",  close: "'"  }],
    ["`",  { type: "quote",   open: "`",  close: "`"  }],
    ["(",  { type: "bracket", open: "(",  close: ")"  }],
    [")",  { type: "bracket", open: "(",  close: ")"  }],
    ["b",  { type: "bracket", open: "(",  close: ")"  }],
    ["[",  { type: "bracket", open: "[",  close: "]"  }],
    ["]",  { type: "bracket", open: "[",  close: "]"  }],
    ["{",  { type: "bracket", open: "{",  close: "}"  }],
    ["}",  { type: "bracket", open: "{",  close: "}"  }],
    ["B",  { type: "bracket", open: "{",  close: "}"  }],
    ["x",  null],  // unknown key
    ["<",  null],  // not supported
  ])(
    "key %j → %j",
    (key, want) => expect(normalizeDelimiterKey(key)).toEqual(want),
  );
});

// ---------------------------------------------------------------------------
// isEscapedDelimiter
// ---------------------------------------------------------------------------

describe("isEscapedDelimiter", () => {
  test.each<[string, number, boolean]>([
    [`\\"`,           1, true  ],  // one backslash → escaped
    [`\\\\"`,         2, false ],  // two backslashes → not escaped
    [`\\\\\\"`,       3, true  ],  // three → escaped
    [`"`,             0, false ],  // index 0 → never escaped (no preceding char)
    [`hello"`,        5, false ],  // no preceding backslash
    [`a\\b`,          2, true  ],  // one backslash at index 1 precedes 'b' at 2 → escaped
  ])(
    "%j @%i → %s",
    (text, idx, want) => expect(isEscapedDelimiter(text, idx)).toBe(want),
  );

  // edge cases
  test("index out of bounds → false", () => {
    expect(isEscapedDelimiter("abc", 5)).toBe(false);
    expect(isEscapedDelimiter("abc", -1)).toBe(false);
  });

  test("non-integer index → false", () => {
    expect(isEscapedDelimiter(`\\"`, 1.5)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// resolveDelimitedTextObjectRange — quotes
// ---------------------------------------------------------------------------

describe("resolveDelimitedTextObjectRange: i\" (inside double-quote)", () => {
  const text = `say "hello world" now`;
  //            0123456789...
  // '"' at 4, '"' at 16

  test("cursor inside: returns interior [5,16)", () => {
    const r = resolveDelimitedTextObjectRange(text, 9, "i", '"');
    expect(r).toEqual({ startAbs: 5, endAbs: 16 });
  });

  test("kind=a includes both delimiters [4,17)", () => {
    const r = resolveDelimitedTextObjectRange(text, 9, "a", '"');
    expect(r).toEqual({ startAbs: 4, endAbs: 17 });
  });

  test("cursor outside quotes → null", () => {
    expect(resolveDelimitedTextObjectRange(text, 0, "i", '"')).toBeNull();
    expect(resolveDelimitedTextObjectRange(text, 20, "i", '"')).toBeNull();
  });
});

describe("resolveDelimitedTextObjectRange: escaped quote is skipped", () => {
  // text: a \"hello\" b  (quotes are \-escaped)
  const text = `a \\"hello\\" b`;

  test("escaped quotes not treated as delimiters → null", () => {
    // No real unescaped pair, so cursor inside → null
    const r = resolveDelimitedTextObjectRange(text, 5, "i", '"');
    expect(r).toBeNull();
  });
});

describe("resolveDelimitedTextObjectRange: i' (inside single-quote)", () => {
  // Use a clean string without apostrophes so pairing is unambiguous
  const text = `say 'hello' now`;
  //            0    5    10
  // "'" at 4, "'" at 10

  test("cursor inside: i' returns [5,10)", () => {
    const r = resolveDelimitedTextObjectRange(text, 7, "i", "'");
    expect(r).toEqual({ startAbs: 5, endAbs: 10 });
  });

  test("cursor outside quotes → null", () => {
    expect(resolveDelimitedTextObjectRange(text, 0, "i", "'")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// resolveDelimitedTextObjectRange — brackets
// ---------------------------------------------------------------------------

describe("resolveDelimitedTextObjectRange: i( (inside parens)", () => {
  const text = "foo(bar, baz)qux";
  //            0123456789...
  // '(' at 3, ')' at 12

  test("cursor inside: i( returns [4,12)", () => {
    const r = resolveDelimitedTextObjectRange(text, 7, "i", "(");
    expect(r).toEqual({ startAbs: 4, endAbs: 12 });
  });

  test("cursor inside: a( returns [3,13)", () => {
    const r = resolveDelimitedTextObjectRange(text, 7, "a", "(");
    expect(r).toEqual({ startAbs: 3, endAbs: 13 });
  });

  test("cursor outside → null", () => {
    expect(resolveDelimitedTextObjectRange(text, 0, "i", "(")).toBeNull();
    expect(resolveDelimitedTextObjectRange(text, 14, "i", "(")).toBeNull();
  });
});

describe("resolveDelimitedTextObjectRange: nested brackets pick innermost", () => {
  const text = "((inner))";
  //            012345678
  // outer: 0..8, inner: 1..7

  test("cursor at inner content: picks inner pair", () => {
    const r = resolveDelimitedTextObjectRange(text, 3, "i", "(");
    // innermost pair: i( → [2,7)
    expect(r).toEqual({ startAbs: 2, endAbs: 7 });
  });

  test("unbalanced (no matching bracket) → null", () => {
    const unbalanced = "(hello";
    expect(resolveDelimitedTextObjectRange(unbalanced, 2, "i", "(")).toBeNull();
  });
});

describe("resolveDelimitedTextObjectRange: i{ and i[", () => {
  test("i{ works", () => {
    const text = "fn {body}";
    const r = resolveDelimitedTextObjectRange(text, 5, "i", "{");
    expect(r).toEqual({ startAbs: 4, endAbs: 8 });
  });

  test("i[ works", () => {
    const text = "arr[0]";
    const r = resolveDelimitedTextObjectRange(text, 4, "i", "[");
    expect(r).toEqual({ startAbs: 4, endAbs: 5 });
  });
});

describe("resolveDelimitedTextObjectRange: unknown key → null", () => {
  test("key x → null", () => {
    expect(resolveDelimitedTextObjectRange("hello", 2, "i", "x")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// resolveMatchingPairMotionTarget  (%)
// ---------------------------------------------------------------------------

describe("resolveMatchingPairMotionTarget: %", () => {
  const line = "foo(bar)baz";
  //            01234567890

  test("cursor on '(' → jumps to ')'", () => {
    const r = resolveMatchingPairMotionTarget(line, 3, 0, line.length);
    expect(r).not.toBeNull();
    expect(r!.sourceAbs).toBe(3);
    expect(r!.targetAbs).toBe(7);
    expect(r!.pair).toBe("()");
  });

  test("cursor on ')' → jumps to '('", () => {
    const r = resolveMatchingPairMotionTarget(line, 7, 0, line.length);
    expect(r).not.toBeNull();
    expect(r!.sourceAbs).toBe(7);
    expect(r!.targetAbs).toBe(3);
  });

  test("cursor before '(' → scans right to find bracket", () => {
    // cursor at 0, first bracket at 3
    const r = resolveMatchingPairMotionTarget(line, 0, 0, line.length);
    expect(r).not.toBeNull();
    expect(r!.sourceAbs).toBe(3);
    expect(r!.targetAbs).toBe(7);
  });

  test("no brackets on line → null", () => {
    const noBrackets = "hello world";
    expect(
      resolveMatchingPairMotionTarget(noBrackets, 0, 0, noBrackets.length),
    ).toBeNull();
  });

  test("nested: cursor on outer '(' → matches outer ')'", () => {
    const nested = "((foo))";
    const r = resolveMatchingPairMotionTarget(nested, 0, 0, nested.length);
    expect(r).not.toBeNull();
    expect(r!.targetAbs).toBe(6);
  });

  test("nested: cursor on inner '(' → matches inner ')'", () => {
    const nested = "((foo))";
    const r = resolveMatchingPairMotionTarget(nested, 1, 0, nested.length);
    expect(r).not.toBeNull();
    expect(r!.targetAbs).toBe(5);
  });

  test("square brackets", () => {
    const s = "a[b]c";
    const r = resolveMatchingPairMotionTarget(s, 1, 0, s.length);
    expect(r!.pair).toBe("[]");
    expect(r!.targetAbs).toBe(3);
  });

  test("curly braces", () => {
    const s = "a{b}c";
    const r = resolveMatchingPairMotionTarget(s, 1, 0, s.length);
    expect(r!.pair).toBe("{}");
    expect(r!.targetAbs).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// resolveWordTextObjectRange — iw / aw
// ---------------------------------------------------------------------------

describe("resolveWordTextObjectRange: iw (inside word)", () => {
  const line = "the quick brown";
  const abs = 0;

  test.each<[string, number, number, number]>([
    // [line,           col, expectedStart, expectedEnd (abs)]
    ["the quick brown",  0,  0,   3],  // 'the'  → [0,3)
    ["the quick brown",  4,  4,   9],  // 'quick'
    ["the quick brown",  10, 10, 15],  // 'brown'
    ["the quick brown",  3,  3,   4],  // space between: iw selects the space run
  ])(
    "%j @%i → [%i, %i)",
    (ln, col, wantStart, wantEnd) => {
      const r = resolveWordTextObjectRange(ln, 0, col, "i");
      expect(r).not.toBeNull();
      expect(r!.startAbs).toBe(wantStart);
      expect(r!.endAbs).toBe(wantEnd);
    },
  );

  test("count=2 selects two runs", () => {
    // iw from 'the' (col 0) with count=2: selects 'the' + ' ' = [0,4)
    const r = resolveWordTextObjectRange(line, abs, 0, "i", 2);
    expect(r).not.toBeNull();
    expect(r!.startAbs).toBe(0);
    expect(r!.endAbs).toBe(4);
  });

  test("count that exceeds available runs → null (nvim no-op)", () => {
    // Only one word on a single-word line
    const r = resolveWordTextObjectRange("hello", 0, 0, "i", 2);
    expect(r).toBeNull();
  });
});

describe("resolveWordTextObjectRange: aw (around word)", () => {
  const line = "the quick brown";

  test("aw on 'the' includes trailing space", () => {
    // 'the' is [0,3); aw should extend to include the space → [0,4)
    const r = resolveWordTextObjectRange(line, 0, 0, "a");
    expect(r).not.toBeNull();
    expect(r!.startAbs).toBe(0);
    expect(r!.endAbs).toBe(4);
  });

  test("aw on 'brown' (last word) includes leading space", () => {
    // 'brown' is at col 10; aw includes preceding space → [9,15)
    const r = resolveWordTextObjectRange(line, 0, 10, "a");
    expect(r).not.toBeNull();
    expect(r!.startAbs).toBe(9);
    expect(r!.endAbs).toBe(15);
  });

  test("aw on whitespace run with following word includes that word", () => {
    // col 3 is the space between 'the' and 'quick'; aw should include the next word
    const r = resolveWordTextObjectRange(line, 0, 3, "a");
    expect(r).not.toBeNull();
    // starts at 3 (space), extends to end of 'quick' at 9
    expect(r!.startAbs).toBe(3);
    expect(r!.endAbs).toBe(9);
  });
});

describe("resolveWordTextObjectRange: WORD class", () => {
  test("iW on foo.bar treats whole token as one WORD", () => {
    const line = "foo.bar baz";
    const r = resolveWordTextObjectRange(line, 0, 0, "i", 1, "WORD");
    expect(r).not.toBeNull();
    expect(r!.startAbs).toBe(0);
    expect(r!.endAbs).toBe(7); // "foo.bar" = 7 chars
  });
});

describe("resolveWordTextObjectRange: edge cases", () => {
  test("empty line → null", () => {
    expect(resolveWordTextObjectRange("", 0, 0, "i")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// resolveQuoteObjectRange (smoke additional coverage)
// ---------------------------------------------------------------------------

describe("resolveQuoteObjectRange: backtick", () => {
  const text = "run `cmd` now";
  //            0123456789...
  // '`' at 4, '`' at 8

  test("i` returns [5,8)", () => {
    const r = resolveQuoteObjectRange(text, 6, "i", "`");
    expect(r).toEqual({ startAbs: 5, endAbs: 8 });
  });

  test("a` returns [4,9)", () => {
    const r = resolveQuoteObjectRange(text, 6, "a", "`");
    expect(r).toEqual({ startAbs: 4, endAbs: 9 });
  });
});

// ---------------------------------------------------------------------------
// resolveBracketObjectRange (smoke additional coverage)
// ---------------------------------------------------------------------------

describe("resolveBracketObjectRange: same-char open/close → null (guard)", () => {
  test("open===close is rejected", () => {
    // The function requires open !== close
    const r = resolveBracketObjectRange("aXbXc", 2, "i", "X", "X");
    expect(r).toBeNull();
  });
});

import type { CharMotion } from "../../src/vim/types.ts";
import { describe, expect, test } from "bun:test";
import {
  findWordMotionTarget,
  findCharMotionTarget,
  findParagraphMotionTarget,
  findFirstNonWhitespaceColumn,
  isBlankLine,
  reverseCharMotion,
  getLineGraphemes,
} from "../../src/vim/motions.ts";

// ---------------------------------------------------------------------------
// isBlankLine
// ---------------------------------------------------------------------------

describe("isBlankLine", () => {
  test.each<[string | undefined, boolean]>([
    ["",          true ],
    [" ",         true ],
    ["\t  \t",    true ],
    ["a",         false],
    ["  a  ",     false],
    [undefined,   true ], // undefined → true (line doesn't exist)
  ])(
    "%j → %s",
    (line, want) => expect(isBlankLine(line)).toBe(want),
  );
});

// ---------------------------------------------------------------------------
// findFirstNonWhitespaceColumn
// ---------------------------------------------------------------------------

describe("findFirstNonWhitespaceColumn", () => {
  test.each<[string, number]>([
    ["hello",       0],
    ["  hello",     2],
    ["\t\thello",   2],
    ["",            0], // blank → 0 per spec
    ["   ",         0], // all-spaces → 0
    [" a",          1],
  ])(
    "%j → %i",
    (line, want) => expect(findFirstNonWhitespaceColumn(line)).toBe(want),
  );
});

// ---------------------------------------------------------------------------
// getLineGraphemes
// ---------------------------------------------------------------------------

describe("getLineGraphemes", () => {
  test("empty string → empty array", () => {
    expect(getLineGraphemes("")).toEqual([]);
  });

  test("ASCII: each char is one segment", () => {
    const segs = getLineGraphemes("abc");
    expect(segs).toEqual([
      { start: 0, end: 1 },
      { start: 1, end: 2 },
      { start: 2, end: 3 },
    ]);
  });

  test("emoji (2-codeunit) is a single grapheme cluster", () => {
    // 😀 is U+1F600, 2 UTF-16 code units
    const segs = getLineGraphemes("😀");
    expect(segs).toHaveLength(1);
    expect(segs[0]).toEqual({ start: 0, end: 2 });
  });

  test("emoji + letter → two graphemes with correct offsets", () => {
    // "😀a": grapheme 0 is [0,2), grapheme 1 is [2,3)
    const segs = getLineGraphemes("😀a");
    expect(segs).toHaveLength(2);
    expect(segs[0]).toEqual({ start: 0, end: 2 });
    expect(segs[1]).toEqual({ start: 2, end: 3 });
  });

  test("combining sequence treated as one cluster", () => {
    // e + combining-acute (U+0301) = é as two code units but one grapheme
    const s = "e\u0301";
    const segs = getLineGraphemes(s);
    expect(segs).toHaveLength(1);
    expect(segs[0]).toEqual({ start: 0, end: 2 });
  });

  test("mixed ascii + emoji spans are contiguous and cover all offsets", () => {
    const line = "a😀b";
    const segs = getLineGraphemes(line);
    // Segments should span [0,1), [1,3), [3,4)
    expect(segs[0]).toEqual({ start: 0, end: 1 });
    expect(segs[1]).toEqual({ start: 1, end: 3 });
    expect(segs[2]).toEqual({ start: 3, end: 4 });
  });
});

// ---------------------------------------------------------------------------
// reverseCharMotion
// ---------------------------------------------------------------------------

describe("reverseCharMotion", () => {
  test.each<[CharMotion, CharMotion]>([
    ["f", "F"],
    ["F", "f"],
    ["t", "T"],
    ["T", "t"],
  ])(
    "%s → %s",
    (motion, want) => expect(reverseCharMotion(motion)).toBe(want),
  );
});

// ---------------------------------------------------------------------------
// findWordMotionTarget — w (forward start)
// ---------------------------------------------------------------------------

describe("findWordMotionTarget: w (forward start, word)", () => {
  test.each<[string, number, number]>([
    // [line,                 col, expected]
    ["the quick brown",       0,   4],  // 'the' → next word 'quick'
    ["the quick brown",       4,   10], // 'quick' → 'brown'
    ["foo.bar",               0,   3],  // punctuation is its own word-class
    ["foo.bar",               3,   4],  // dot → 'bar'
    ["  leading",             0,   2],  // whitespace: skip to first word
    ["hello",                 4,   5],  // at-last-char → clamp to len
    ["hello world",           5,   6],  // on space → next word
  ])(
    "%j @%i → %i",
    (line, col, want) =>
      expect(findWordMotionTarget(line, col, "forward", "start", "word")).toBe(want),
  );
});

describe("findWordMotionTarget: w (forward start, WORD)", () => {
  test.each<[string, number, number]>([
    // WORD treats all non-whitespace as one class
    ["foo.bar baz",   0,   8],  // "foo.bar" is one WORD
    ["  foo.bar",     0,   2],  // leading ws → first WORD
    ["foo.bar",       0,   7],  // whole string is one WORD → len
  ])(
    "%j @%i → %i",
    (line, col, want) =>
      expect(findWordMotionTarget(line, col, "forward", "start", "WORD")).toBe(want),
  );
});

// ---------------------------------------------------------------------------
// findWordMotionTarget — e (forward end)
// ---------------------------------------------------------------------------

describe("findWordMotionTarget: e (forward end, word)", () => {
  test.each<[string, number, number]>([
    ["the quick",     0,   2],  // end of 'the'
    ["the quick",     3,   8],  // from space after 'the' → end of 'quick' ('k' at 8)
    ["foo.bar",       0,   2],  // end of 'foo'
    ["foo.bar",       3,   6],  // end of 'bar'
  ])(
    "%j @%i → %i",
    (line, col, want) =>
      expect(findWordMotionTarget(line, col, "forward", "end", "word")).toBe(want),
  );
});

// ---------------------------------------------------------------------------
// findWordMotionTarget — b (backward start)
// ---------------------------------------------------------------------------

describe("findWordMotionTarget: b (backward start, word)", () => {
  test.each<[string, number, number]>([
    ["the quick",     9,   4],  // end-of-'quick' → start of 'quick'
    ["the quick",     4,   0],  // start-of-'quick' → start of 'the'
    ["foo.bar",       6,   4],  // end-of-'bar' → start of 'bar'
    ["foo.bar",       4,   3],  // 'bar' start → '.' (punct word)
    ["hello",         0,   0],  // at start: stays at start
  ])(
    "%j @%i → %i",
    (line, col, want) =>
      expect(findWordMotionTarget(line, col, "backward", "start", "word")).toBe(want),
  );
});

// ---------------------------------------------------------------------------
// findCharMotionTarget — f (inclusive forward)
// ---------------------------------------------------------------------------

describe("findCharMotionTarget: f (forward inclusive)", () => {
  test.each<[string, number, string, number | null]>([
    ["hello world",     0,  "o",   4  ],  // first 'o' at index 4
    ["hello world",     4,  "o",   7  ],  // second 'o' (from current 'o')
    ["hello world",     0,  "z",   null], // not found
    ["abcabc",          0,  "b",   1  ],  // first 'b'
    ["abcabc",          0,  "a",   3  ],  // skip col-0 'a', find next at 3
  ])(
    "%j @%i f%s → %s",
    (line, col, ch, want) =>
      expect(findCharMotionTarget(line, col, "f", ch)).toBe(want),
  );
});

describe("findCharMotionTarget: f with count", () => {
  test("count=2 skips to the second occurrence", () => {
    // "xaxax": 'a' at 1 and 3; f'a' count=2 from col 0 → 3
    expect(findCharMotionTarget("xaxax", 0, "f", "a", false, 2)).toBe(3);
  });

  test("count=3 when only 2 occurrences ahead → null", () => {
    // "xaxax": only 2 'a's → count=3 returns null
    expect(findCharMotionTarget("xaxax", 0, "f", "a", false, 3)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// findCharMotionTarget — F (backward inclusive)
// ---------------------------------------------------------------------------

describe("findCharMotionTarget: F (backward inclusive)", () => {
  test.each<[string, number, string, number | null]>([
    ["hello world",   11,  "o",   7  ],  // last 'o' backward from end
    ["hello world",    7,  "o",   4  ],  // previous 'o'
    ["hello world",    0,  "h",   null], // can't go backward from col 0
    ["hello world",    4,  "z",   null], // char not on line
  ])(
    "%j @%i F%s → %s",
    (line, col, ch, want) =>
      expect(findCharMotionTarget(line, col, "F", ch)).toBe(want),
  );
});

// ---------------------------------------------------------------------------
// findCharMotionTarget — t (till, exclusive forward)
// ---------------------------------------------------------------------------

describe("findCharMotionTarget: t (forward till)", () => {
  test.each<[string, number, string, number | null]>([
    ["hello world",   0,  "o",   3 ],  // stop 1 before 'o' at index 4
    ["hello world",   0,  "w",   5 ],  // stop before 'w' at index 6
    ["hello world",   0,  "z",   null], // not found
  ])(
    "%j @%i t%s → %s",
    (line, col, ch, want) =>
      expect(findCharMotionTarget(line, col, "t", ch)).toBe(want),
  );
});

// ---------------------------------------------------------------------------
// findCharMotionTarget — T (till backward)
// ---------------------------------------------------------------------------

describe("findCharMotionTarget: T (backward till)", () => {
  test.each<[string, number, string, number | null]>([
    ["hello world",   11, "o",   8 ],  // 1 after 'o' at index 7
    ["hello world",    5, "h",   1 ],  // 1 after 'h' at index 0
    ["hello world",    0, "o",   null], // can't go backward
  ])(
    "%j @%i T%s → %s",
    (line, col, ch, want) =>
      expect(findCharMotionTarget(line, col, "T", ch)).toBe(want),
  );
});

// ---------------------------------------------------------------------------
// findCharMotionTarget — repeat (;) semantics for t
// ---------------------------------------------------------------------------

describe("findCharMotionTarget: isRepeat for t", () => {
  // When repeating t (;), the till offset shifts so the cursor can advance past
  // a previous "stopped before" position.
  test("t non-repeat from 0 → before first b (index 0)", () => {
    // "abab": t'b' from col 0 stops before b at 1 → col 0
    expect(findCharMotionTarget("abab", 0, "t", "b")).toBe(0);
  });

  test("t repeat from 0 → before second b (index 2)", () => {
    // isRepeat=true shifts the search start past the previous till-stop
    expect(findCharMotionTarget("abab", 0, "t", "b", true)).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// findParagraphMotionTarget
// ---------------------------------------------------------------------------

describe("findParagraphMotionTarget: } (forward)", () => {
  const lines = [
    "para one line 1",
    "para one line 2",
    "",
    "para two line 1",
    "para two line 2",
    "",
    "para three",
  ];

  test("from line 0, 1 step → line 3", () => {
    expect(findParagraphMotionTarget(lines, 0, "forward", 1)).toBe(3);
  });

  test("from line 3, 1 step → line 6", () => {
    expect(findParagraphMotionTarget(lines, 3, "forward", 1)).toBe(6);
  });

  test("from last paragraph, forward → clamps to last line", () => {
    expect(findParagraphMotionTarget(lines, 6, "forward", 1)).toBe(6);
  });

  test("count=2 from line 0 → jumps two paragraphs", () => {
    expect(findParagraphMotionTarget(lines, 0, "forward", 2)).toBe(6);
  });
});

describe("findParagraphMotionTarget: { (backward)", () => {
  const lines = [
    "para one",
    "",
    "para two",
    "",
    "para three",
  ];

  test("from line 4, 1 step → line 2", () => {
    expect(findParagraphMotionTarget(lines, 4, "backward", 1)).toBe(2);
  });

  test("from line 2, 1 step → line 0", () => {
    expect(findParagraphMotionTarget(lines, 2, "backward", 1)).toBe(0);
  });

  test("from line 0, backward → stays at 0", () => {
    expect(findParagraphMotionTarget(lines, 0, "backward", 1)).toBe(0);
  });
});

describe("findParagraphMotionTarget: edge cases", () => {
  test("empty lines array → 0", () => {
    expect(findParagraphMotionTarget([], 0, "forward")).toBe(0);
  });

  test("single line → 0 both directions", () => {
    expect(findParagraphMotionTarget(["only"], 0, "forward")).toBe(0);
    expect(findParagraphMotionTarget(["only"], 0, "backward")).toBe(0);
  });
});

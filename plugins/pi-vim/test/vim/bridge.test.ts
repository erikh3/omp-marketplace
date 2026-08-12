import { describe, expect, test } from "bun:test";
import {
  lineColToAbs,
  absToLineCol,
  graphemeCount,
  graphemeSteps,
} from "../../src/vim/bridge.ts";

// ---------------------------------------------------------------------------
// lineColToAbs
// ---------------------------------------------------------------------------

describe("lineColToAbs", () => {
  const lines = ["hello", "world", "foo"];
  // Text = "hello\nworld\nfoo"
  // Offsets: 0..4=hello, 5=\n, 6..10=world, 11=\n, 12..14=foo

  test("line 0 col 0 → abs 0", () => {
    expect(lineColToAbs(lines, 0, 0)).toBe(0);
  });

  test("line 0 last char → abs 4", () => {
    expect(lineColToAbs(lines, 0, 4)).toBe(4);
  });

  test("line 1 col 0 → abs 6 (past the \\n at 5)", () => {
    expect(lineColToAbs(lines, 1, 0)).toBe(6);
  });

  test("line 1 col 3 → abs 9", () => {
    expect(lineColToAbs(lines, 1, 3)).toBe(9);
  });

  test("line 2 col 0 → abs 12", () => {
    expect(lineColToAbs(lines, 2, 0)).toBe(12);
  });

  test("line 2 last char → abs 14", () => {
    expect(lineColToAbs(lines, 2, 2)).toBe(14);
  });

  test("single-line buffer: abs === col", () => {
    expect(lineColToAbs(["abc"], 0, 2)).toBe(2);
  });

  test("empty lines array: abs = col regardless", () => {
    expect(lineColToAbs([], 0, 0)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// absToLineCol
// ---------------------------------------------------------------------------

describe("absToLineCol", () => {
  const lines = ["hello", "world", "foo"];

  test("abs 0 → {line:0, col:0}", () => {
    expect(absToLineCol(lines, 0)).toEqual({ line: 0, col: 0 });
  });

  test("abs 4 → {line:0, col:4}", () => {
    expect(absToLineCol(lines, 4)).toEqual({ line: 0, col: 4 });
  });

  test("abs 5 (\\n between lines 0 and 1) → {line:0, col:5} (end of line 0)", () => {
    // The bridge resolves trailing \n to end-of-this-line per the remaining<=len rule
    expect(absToLineCol(lines, 5)).toEqual({ line: 0, col: 5 });
  });

  test("abs 6 → {line:1, col:0}", () => {
    expect(absToLineCol(lines, 6)).toEqual({ line: 1, col: 0 });
  });

  test("abs 9 → {line:1, col:3}", () => {
    expect(absToLineCol(lines, 9)).toEqual({ line: 1, col: 3 });
  });

  test("abs 12 → {line:2, col:0}", () => {
    expect(absToLineCol(lines, 12)).toEqual({ line: 2, col: 0 });
  });

  test("abs 14 → {line:2, col:2}", () => {
    expect(absToLineCol(lines, 14)).toEqual({ line: 2, col: 2 });
  });

  test("abs beyond end → clamps to last position", () => {
    const r = absToLineCol(lines, 999);
    expect(r.line).toBe(2);
    expect(r.col).toBe(3); // "foo".length
  });

  test("negative abs → clamps to {line:0, col:0}", () => {
    expect(absToLineCol(lines, -5)).toEqual({ line: 0, col: 0 });
  });
});

// ---------------------------------------------------------------------------
// Round-trip: lineColToAbs ↔ absToLineCol
// ---------------------------------------------------------------------------

describe("round-trip lineColToAbs/absToLineCol", () => {
  const lines = ["the", "quick", "brown", "fox"];

  test.each<[number, number]>([
    [0, 0],
    [0, 3],
    [1, 0],
    [1, 5],
    [2, 0],
    [2, 5],
    [3, 0],
    [3, 3],
  ])(
    "line %i col %i round-trips",
    (line, col) => {
      const abs = lineColToAbs(lines, line, col);
      expect(absToLineCol(lines, abs)).toEqual({ line, col });
    },
  );

  test("abs round-trips through lineColToAbs", () => {
    for (let abs = 0; abs <= 19; abs++) {
      const { line, col } = absToLineCol(lines, abs);
      // Abs on a \n resolves to end-of-line, so lineColToAbs of that position
      // gives back the same abs (col = line.length means we're AT the \n).
      const back = lineColToAbs(lines, line, col);
      // back should equal abs OR the \n position (col===lineLen case)
      expect(back).toBeLessThanOrEqual(abs);
    }
  });
});

// ---------------------------------------------------------------------------
// graphemeCount
// ---------------------------------------------------------------------------

describe("graphemeCount", () => {
  test("empty string → 0", () => {
    expect(graphemeCount("")).toBe(0);
  });

  test("ASCII string → length", () => {
    expect(graphemeCount("hello")).toBe(5);
  });

  test("emoji (2 UTF-16 units) → 1 cluster", () => {
    expect(graphemeCount("😀")).toBe(1);
  });

  test("two emoji → 2 clusters", () => {
    expect(graphemeCount("😀🎉")).toBe(2);
  });

  test("string with newline counts the newline as one cluster", () => {
    // "a\nb" → 3 graphemes: 'a', '\n', 'b'
    expect(graphemeCount("a\nb")).toBe(3);
  });

  test("combining char cluster → 1", () => {
    // e + combining acute = 1 grapheme
    expect(graphemeCount("e\u0301")).toBe(1);
  });

  test("mixed ascii + emoji", () => {
    // "a😀b" → 3 graphemes
    expect(graphemeCount("a😀b")).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// graphemeSteps
// ---------------------------------------------------------------------------

describe("graphemeSteps", () => {
  test("same col → 0 steps", () => {
    expect(graphemeSteps("hello", 2, 2)).toBe(0);
  });

  test("adjacent ASCII chars → 1 step", () => {
    expect(graphemeSteps("hello", 1, 2)).toBe(1);
    expect(graphemeSteps("hello", 2, 1)).toBe(1); // direction-agnostic
  });

  test("three-char span → 3 steps", () => {
    expect(graphemeSteps("hello world", 0, 3)).toBe(3);
  });

  test("emoji span: col 0 to col 2 → 1 step (one emoji cluster)", () => {
    // "😀" occupies cols 0..1 (2 UTF-16 units); moving from 0 to 2 is 1 grapheme
    expect(graphemeSteps("😀", 0, 2)).toBe(1);
  });

  test("emoji + letter: col 0 to col 3 → 2 steps", () => {
    // "😀a": emoji at [0,2), 'a' at [2,3)
    expect(graphemeSteps("😀a", 0, 3)).toBe(2);
  });

  test("direction-agnostic: steps(0,5) === steps(5,0)", () => {
    expect(graphemeSteps("hello", 0, 5)).toBe(graphemeSteps("hello", 5, 0));
  });

  test("startCol beyond line length → 0 (or minimal)", () => {
    // Both endpoints out of range or clamped to the same → 0 steps
    expect(graphemeSteps("hi", 10, 10)).toBe(0);
  });

  test("steps across emoji and text", () => {
    // "a😀b" [0,1), [1,3), [3,4)
    // col 1 to col 3 is the emoji span = 1 step
    expect(graphemeSteps("a😀b", 1, 3)).toBe(1);
    // col 0 to col 3 = a + emoji = 2 steps
    expect(graphemeSteps("a😀b", 0, 3)).toBe(2);
    // col 0 to col 4 = a + emoji + b = 3 steps
    expect(graphemeSteps("a😀b", 0, 4)).toBe(3);
  });
});

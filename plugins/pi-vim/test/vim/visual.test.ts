import type { Mode } from "../../src/vim/types.ts";
import { describe, expect, test } from "bun:test";
import {
  isVisualMode,
  compareVisualPositions,
  orderVisualEndpoints,
  getVisualLineRange,
  getInclusiveEndColumn,
  clampVisualPosition,
} from "../../src/vim/visual.ts";

// ---------------------------------------------------------------------------
// isVisualMode
// ---------------------------------------------------------------------------

describe("isVisualMode", () => {
  test.each<[Mode, boolean]>([
    ["visual",       true ],
    ["visual-line",  true ],
    ["normal",       false],
    ["insert",       false],
  ])(
    "%s → %s",
    (mode, want) => expect(isVisualMode(mode)).toBe(want),
  );
});

// ---------------------------------------------------------------------------
// compareVisualPositions
// ---------------------------------------------------------------------------

describe("compareVisualPositions", () => {
  test("same position → 0", () => {
    expect(compareVisualPositions({ line: 2, col: 5 }, { line: 2, col: 5 })).toBe(0);
  });

  test("a before b (line) → negative", () => {
    expect(compareVisualPositions({ line: 1, col: 0 }, { line: 2, col: 0 })).toBeLessThan(0);
  });

  test("a after b (line) → positive", () => {
    expect(compareVisualPositions({ line: 3, col: 0 }, { line: 1, col: 0 })).toBeGreaterThan(0);
  });

  test("same line, a.col < b.col → negative", () => {
    expect(compareVisualPositions({ line: 0, col: 2 }, { line: 0, col: 5 })).toBeLessThan(0);
  });

  test("same line, a.col > b.col → positive", () => {
    expect(compareVisualPositions({ line: 0, col: 9 }, { line: 0, col: 3 })).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// orderVisualEndpoints
// ---------------------------------------------------------------------------

describe("orderVisualEndpoints", () => {
  test("anchor precedes cursor → start=anchor, end=cursor", () => {
    const anchor = { line: 0, col: 2 };
    const cursor = { line: 0, col: 7 };
    const { start, end } = orderVisualEndpoints(anchor, cursor);
    expect(start).toEqual(anchor);
    expect(end).toEqual(cursor);
  });

  test("cursor precedes anchor → start=cursor, end=anchor", () => {
    const anchor = { line: 2, col: 5 };
    const cursor = { line: 1, col: 3 };
    const { start, end } = orderVisualEndpoints(anchor, cursor);
    expect(start).toEqual(cursor);
    expect(end).toEqual(anchor);
  });

  test("same position → both start and end equal that position", () => {
    const pos = { line: 0, col: 0 };
    const { start, end } = orderVisualEndpoints(pos, pos);
    expect(start).toEqual(pos);
    expect(end).toEqual(pos);
  });

  test("anchor on earlier col, cursor later col, same line", () => {
    const anchor = { line: 0, col: 10 };
    const cursor = { line: 0, col: 15 };
    const { start } = orderVisualEndpoints(anchor, cursor);
    expect(start).toEqual(anchor);
  });

  test("multi-line: correct ordering", () => {
    const anchor = { line: 5, col: 0 };
    const cursor = { line: 2, col: 99 };
    const { start, end } = orderVisualEndpoints(anchor, cursor);
    expect(start).toEqual(cursor);
    expect(end).toEqual(anchor);
  });
});

// ---------------------------------------------------------------------------
// getVisualLineRange
// ---------------------------------------------------------------------------

describe("getVisualLineRange", () => {
  test("anchor.line < cursor.line → startLine=anchor.line", () => {
    const r = getVisualLineRange({ line: 1, col: 0 }, { line: 4, col: 5 });
    expect(r).toEqual({ startLine: 1, endLine: 4 });
  });

  test("cursor.line < anchor.line → startLine=cursor.line", () => {
    const r = getVisualLineRange({ line: 5, col: 0 }, { line: 2, col: 0 });
    expect(r).toEqual({ startLine: 2, endLine: 5 });
  });

  test("same line → startLine === endLine", () => {
    const r = getVisualLineRange({ line: 3, col: 0 }, { line: 3, col: 9 });
    expect(r).toEqual({ startLine: 3, endLine: 3 });
  });
});

// ---------------------------------------------------------------------------
// getInclusiveEndColumn
// ---------------------------------------------------------------------------

describe("getInclusiveEndColumn", () => {
  test("ASCII: col + 1 for regular char", () => {
    expect(getInclusiveEndColumn("hello", 2)).toBe(3); // 'l' at 2 → next boundary at 3
  });

  test("last char of line", () => {
    expect(getInclusiveEndColumn("hello", 4)).toBe(5);
  });

  test("col at line length → line length", () => {
    expect(getInclusiveEndColumn("hello", 5)).toBe(5);
  });

  test("col beyond line length → line length", () => {
    expect(getInclusiveEndColumn("hello", 99)).toBe(5);
  });

  test("emoji at col 0: end = 2 (whole cluster)", () => {
    // "😀" is 2 UTF-16 units; col 0 should yield end=2
    expect(getInclusiveEndColumn("😀", 0)).toBe(2);
  });

  test("emoji: col 1 (inside surrogate pair) → still end of cluster = 2", () => {
    expect(getInclusiveEndColumn("😀a", 1)).toBe(2);
  });

  test("letter after emoji: col 2 → end 3", () => {
    expect(getInclusiveEndColumn("😀a", 2)).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// clampVisualPosition
// ---------------------------------------------------------------------------

describe("clampVisualPosition", () => {
  const lines = ["hello", "world", "!"];

  test("position inside bounds → unchanged", () => {
    expect(clampVisualPosition({ line: 1, col: 3 }, lines)).toEqual({ line: 1, col: 3 });
  });

  test("line too large → clamps to last line", () => {
    const p = clampVisualPosition({ line: 99, col: 0 }, lines);
    expect(p.line).toBe(2); // last line index
  });

  test("col too large → clamps to line length", () => {
    const p = clampVisualPosition({ line: 0, col: 99 }, lines);
    expect(p.col).toBe(5); // "hello".length
  });

  test("negative line → clamps to 0", () => {
    const p = clampVisualPosition({ line: -5, col: 0 }, lines);
    expect(p.line).toBe(0);
  });

  test("negative col → clamps to 0", () => {
    const p = clampVisualPosition({ line: 0, col: -3 }, lines);
    expect(p.col).toBe(0);
  });

  test("empty lines array: clamps to {line:0, col:0}", () => {
    const p = clampVisualPosition({ line: 2, col: 5 }, []);
    expect(p).toEqual({ line: 0, col: 0 });
  });
});

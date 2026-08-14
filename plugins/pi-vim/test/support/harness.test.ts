/**
 * Self-tests for the test harness itself: the cursor-marker round-trip, the
 * keystroke notation, and a few end-to-end editor cases that prove `seed`/`send`/
 * `state`/`vt` drive a real {@link ModalVimEditor} correctly. If these fail, every
 * suite built on the harness is suspect, so they live beside it.
 */

import { createHarness, describe, expect, test, vt } from "./harness.ts";
import { keys } from "./keys.ts";
import { parseState, renderState } from "./state.ts";

describe("state: cursor-marker round-trip", () => {
	test("parses single-line position", () => {
		expect(parseState("the |quick")).toEqual({ text: "the quick", line: 0, col: 4 });
	});
	test("parses multi-line position", () => {
		expect(parseState("first\nse|cond")).toEqual({ text: "first\nsecond", line: 1, col: 2 });
	});
	test("renders back to the marker string", () => {
		expect(renderState({ text: "the quick", line: 0, col: 4 })).toBe("the |quick");
		expect(renderState({ text: "first\nsecond", line: 1, col: 2 })).toBe("first\nse|cond");
	});
	test("throws on missing / duplicate marker", () => {
		expect(() => parseState("no marker")).toThrow();
		expect(() => parseState("a|b|c")).toThrow();
	});
});

describe("keys: notation expansion", () => {
	test("literals are one chunk per code point", () => {
		expect(keys("abc")).toEqual(["a", "b", "c"]);
	});
	test("tokens map to byte sequences", () => {
		expect(keys("<Esc>")).toEqual(["\x1b"]);
		expect(keys("<CR>")).toEqual(["\r"]);
		expect(keys("<C-r>")).toEqual(["\x12"]);
		expect(keys("<Left>")).toEqual(["\x1b[D"]);
	});
	test("mixes tokens and literals", () => {
		expect(keys("i<Esc>dw")).toEqual(["i", "\x1b", "d", "w"]);
	});
	test("bracketed paste is one wrapped chunk", () => {
		expect(keys("[paste]hi[/paste]")).toEqual(["\x1b[200~hi\x1b[201~"]);
	});
	test("<lt> is a literal '<'", () => {
		expect(keys("<lt>x")).toEqual(["<", "x"]);
	});
});

describe("harness: seed / send / state", () => {
	test("seed places the buffer and cursor; state round-trips", () => {
		const h = createHarness();
		h.seed("the |quick");
		expect(h.state()).toBe("the |quick");
		expect(h.ed.mode).toBe("insert");
	});
	test("captures mode-change effects", () => {
		const h = createHarness();
		h.seed("|abc");
		h.send("<Esc>");
		expect(h.ed.mode).toBe("normal");
		expect(h.fx.modes).toEqual(["normal"]);
	});
});

// End-to-end editor cases proving the vt runner against known behavior.
describe("harness: vt end-to-end", () => {
	// Default mode is INSERT; typing lands in the buffer.
	vt({ before: "|", keys: "abc", after: "abc|", mode: "insert" });
	// Esc -> NORMAL steps left one grapheme; a printable NORMAL key is swallowed.
	vt({ before: "ab|c", keys: "<Esc>", after: "a|bc", mode: "normal" });
	// dw deletes a word forward.
	vt({ before: "|the quick", keys: "<Esc>dw", after: "|quick", mode: "normal" });
	// x deletes the char under the cursor (Esc first steps left onto 'b').
	vt({ before: "ab|c", keys: "<Esc>x", after: "a|c" });
});

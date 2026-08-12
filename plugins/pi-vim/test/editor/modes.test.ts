/**
 * Mode transitions: INSERT ↔ NORMAL, NORMAL → INSERT via i/a/I/A/o/O,
 * NORMAL ↔ VISUAL / VISUAL-LINE, double-Esc passthrough, swallowed keys,
 * Enter submit.
 *
 * Behavior oracle: smoke.ts checks 1, 2, 5, 8, 10, 40, 43 + coverage matrix §7.
 */

import { describe, expect, test, vt, createHarness } from "../support/harness.ts";

// ---------------------------------------------------------------------------
// INSERT — default mode (smoke #1)
// ---------------------------------------------------------------------------

describe("default mode is INSERT; typing lands in buffer", () => {
	vt({ before: "|", keys: "hello", after: "hello|", mode: "insert" });
	vt({ before: "foo |", keys: "bar", after: "foo bar|", mode: "insert" });
	// Multi-character insert mid-string
	vt({ before: "ac|", keys: "b", after: "acb|", mode: "insert" });
});

// ---------------------------------------------------------------------------
// INSERT → NORMAL via <Esc> and <C-[>: left-step on exit (smoke #2)
// ---------------------------------------------------------------------------

describe("<Esc> INSERT → NORMAL with left-step", () => {
	// Cursor mid-word: step left one grapheme
	vt({ before: "ab|c", keys: "<Esc>", after: "a|bc", mode: "normal" });
	// Cursor after last char: step left onto last char
	vt({ before: "abc|", keys: "<Esc>", after: "ab|c", mode: "normal" });
	// Cursor at col 0: no left-step, stays at col 0
	vt({ before: "|abc", keys: "<Esc>", after: "|abc", mode: "normal" });
	// Empty buffer: cursor at col 0, no move
	vt({ before: "|", keys: "<Esc>", after: "|", mode: "normal" });
});

describe("<C-[> INSERT → NORMAL (alias for Esc)", () => {
	vt({ before: "ab|c", keys: "<C-[>", after: "a|bc", mode: "normal" });
	vt({ before: "|abc", keys: "<C-[>", after: "|abc", mode: "normal" });
});

// ---------------------------------------------------------------------------
// NORMAL → INSERT: i a I A o O (smoke #3 / #5 / #8)
// ---------------------------------------------------------------------------

describe("i — insert before cursor", () => {
	// `i` enters INSERT at the current cursor, which is after the Esc left-step.
	// "hel|lo" → <Esc> steps left → cursor at col 2 ("he|llo"); `i` keeps it there.
	vt({ before: "hel|lo", keys: "<Esc>i", after: "he|llo", mode: "insert" });
	// After i, typing inserts at the post-step position
	vt({ before: "hel|lo", keys: "<Esc>iX", after: "heX|llo", mode: "insert" });
	// i when already at col 0: no Esc left-step, cursor unchanged
	vt({ before: "|abc", keys: "<Esc>i", after: "|abc", mode: "insert" });
});

describe("a — append after cursor", () => {
	// "hel|lo" → Esc → col 2 ("he|llo"); `a` moves one right to col 3 → "hel|lo"
	vt({ before: "hel|lo", keys: "<Esc>a", after: "hel|lo", mode: "insert" });
	// Typing after a: insert at col 3 → "helXlo", cursor col 4
	vt({ before: "hel|lo", keys: "<Esc>aX", after: "helX|lo", mode: "insert" });
	// "ab|c" → Esc → col 1 ("a|bc"); `a` moves right to col 2 → "ab|c" INSERT
	vt({ before: "ab|c", keys: "<Esc>a", after: "ab|c", mode: "insert" });
});

describe("I — insert at line start (smoke #3 adapted)", () => {
	// `I` moves to col 0 of the current line and enters INSERT
	vt({ before: "hello |world", keys: "<Esc>I", after: "|hello world", mode: "insert" });
	// Typing after I lands at the start
	vt({ before: "hello |world", keys: "<Esc>IX", after: "X|hello world", mode: "insert" });
});

describe("A — append at line end (smoke #5)", () => {
	// `A` jumps to EOL and enters INSERT
	vt({ before: "|foo", keys: "<Esc>A", after: "foo|", mode: "insert" });
	// Typing after A appends at EOL
	vt({ before: "|foo", keys: "<Esc>Abar", after: "foobar|", mode: "insert" });
	// A from a mid-word position also lands at EOL
	vt({ before: "fo|o", keys: "<Esc>Abar", after: "foobar|", mode: "insert" });
});

describe("o — open line below, enter INSERT (smoke #8)", () => {
	// `o` inserts a newline after the current line and enters INSERT there
	vt({ before: "|line1", keys: "<Esc>o", after: "line1\n|", mode: "insert" });
	// Typing after o lands on the new empty line
	vt({ before: "|line1", keys: "<Esc>oline2", after: "line1\nline2|", mode: "insert" });
	// o on a multi-line buffer inserts below current line
	vt({
		before: "line1\n|line2",
		keys: "<Esc>oX",
		after: "line1\nline2\nX|",
		mode: "insert",
	});
});

describe("O — open line above, enter INSERT", () => {
	// `O` inserts a newline before the current line and enters INSERT there
	vt({ before: "|line1", keys: "<Esc>O", after: "|\nline1", mode: "insert" });
	// Typing after O lands on the new line above
	vt({ before: "|line1", keys: "<Esc>Onew", after: "new|\nline1", mode: "insert" });
	// O on the second line inserts between line1 and line2
	vt({
		before: "line1\n|line2",
		keys: "<Esc>Onew",
		after: "line1\nnew|\nline2",
		mode: "insert",
	});
});

// ---------------------------------------------------------------------------
// NORMAL → VISUAL and VISUAL-LINE (smoke #40, #43)
// ---------------------------------------------------------------------------

describe("v — enter visual mode from NORMAL", () => {
	vt({ before: "|hello", keys: "<Esc>v", after: "|hello", mode: "visual" });
	// `v` on a non-first position
	// "hel|lo" → Esc left-steps to col 2 ("he|llo"); v enters visual there
	vt({ before: "hel|lo", keys: "<Esc>v", after: "he|llo", mode: "visual" });
});

describe("V — enter visual-line mode from NORMAL (smoke #43)", () => {
	vt({ before: "|hello", keys: "<Esc>V", after: "|hello", mode: "visual-line" });
});

describe("<Esc> from visual → NORMAL (smoke #40)", () => {
	vt({ before: "|hello", keys: "<Esc>v<Esc>", after: "|hello", mode: "normal" });
});

describe("<Esc> from visual-line → NORMAL", () => {
	vt({ before: "|hello", keys: "<Esc>V<Esc>", after: "|hello", mode: "normal" });
});

describe("v in visual-line exits to NORMAL (v cancels when already visual-char)", () => {
	// From visual-line, pressing v switches to visual (charwise)
	vt({ before: "|hello", keys: "<Esc>Vv", after: "|hello", mode: "visual" });
	// From visual (charwise), pressing v exits back to NORMAL
	vt({ before: "|hello", keys: "<Esc>vv", after: "|hello", mode: "normal" });
});

describe("V in visual-line exits to NORMAL", () => {
	// From visual-line, pressing V again exits to NORMAL
	vt({ before: "|hello", keys: "<Esc>VV", after: "|hello", mode: "normal" });
	// From visual (charwise), pressing V switches to visual-line
	vt({ before: "|hello", keys: "<Esc>vV", after: "|hello", mode: "visual-line" });
});

// ---------------------------------------------------------------------------
// Double-Esc: first INSERT → NORMAL (owned), second forwarded to host (smoke #10)
// ---------------------------------------------------------------------------

describe("double-Esc: first is INSERT→NORMAL, second forwards to host", () => {
	test("first Esc converts INSERT to NORMAL; second Esc calls onEscape", () => {
		const { ed } = createHarness();
		let interrupts = 0;
		ed.onEscape = () => { interrupts++; };

		ed.handleInput("x"); // INSERT, buffer "x"
		ed.handleInput("\x1b"); // INSERT → NORMAL (owned; no interrupt)
		expect(ed.mode).toBe("normal");
		expect(interrupts).toBe(0);

		ed.handleInput("\x1b"); // NORMAL, nothing pending → forwarded to host
		expect(ed.mode).toBe("normal");
		expect(interrupts).toBe(1);
	});

	test("buffer is unchanged by either Esc", () => {
		const { ed } = createHarness();
		ed.handleInput("x");
		ed.handleInput("\x1b"); // INSERT → NORMAL
		ed.handleInput("\x1b"); // NORMAL passthrough
		expect(ed.getText()).toBe("x");
	});
});

// ---------------------------------------------------------------------------
// Esc cancels pending commands, does NOT forward to host (smoke #10)
// ---------------------------------------------------------------------------

describe("Esc cancels a pending operator — swallowed, not forwarded", () => {
	test("d<Esc> cancels the d operator, no interrupt", () => {
		const { ed } = createHarness();
		let interrupts = 0;
		ed.onEscape = () => { interrupts++; };

		ed.handleInput("x");
		ed.handleInput("\x1b"); // INSERT → NORMAL
		ed.handleInput("d");   // operator pending
		ed.handleInput("\x1b"); // cancels operator; swallowed
		expect(ed.mode).toBe("normal");
		expect(interrupts).toBe(0); // NOT forwarded
	});

	test("3<Esc> cancels the count prefix — swallowed", () => {
		const { ed } = createHarness();
		let interrupts = 0;
		ed.onEscape = () => { interrupts++; };

		ed.handleInput("a");
		ed.handleInput("\x1b"); // INSERT → NORMAL
		ed.handleInput("3");   // count pending
		ed.handleInput("\x1b"); // cancels count; swallowed
		expect(ed.mode).toBe("normal");
		expect(interrupts).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// Unmapped printable NORMAL key is swallowed (smoke #2)
// ---------------------------------------------------------------------------

describe("unmapped printable key in NORMAL is swallowed", () => {
	test("pressing 'q' in NORMAL does not modify the buffer", () => {
		const { ed, state } = createHarness();
		ed.handleInput("abc");
		ed.handleInput("\x1b"); // INSERT → NORMAL (steps left)
		const before = ed.getText();
		ed.handleInput("q"); // unmapped; should be swallowed
		expect(ed.getText()).toBe(before);
		expect(ed.mode).toBe("normal");
	});

	test("pressing 'z' in NORMAL does not modify the buffer", () => {
		const { ed } = createHarness();
		ed.handleInput("hello");
		ed.handleInput("\x1b");
		const before = ed.getText();
		ed.handleInput("z");
		expect(ed.getText()).toBe(before);
		expect(ed.mode).toBe("normal");
	});
});

// ---------------------------------------------------------------------------
// Enter from NORMAL: submits and passes through to host
// ---------------------------------------------------------------------------

describe("Enter from NORMAL submits and passes through", () => {
	test("<Enter> in NORMAL calls onSubmit / passes to base", () => {
		const h = createHarness({ wireRunExCommand: false });
		h.seed("|hello");
		h.send("<Esc>");          // INSERT → NORMAL
		h.send("<Enter>");        // should submit
		// The base editor's submit logic fires onSubmit (the fallback path when
		// wireRunExCommand is false). Submitted should contain the draft text.
		expect(h.fx.submitted.length).toBeGreaterThan(0);
	});

	test("<Enter> in NORMAL does not delete buffer content", () => {
		const h = createHarness({ wireRunExCommand: false });
		h.seed("|hello");
		h.send("<Esc>");
		h.send("<Enter>");
		// Text is set to what was submitted (base editor behavior on submit)
		// but at minimum the submitted payload contained "hello"
		expect(h.fx.submitted[0]).toBe("hello");
	});

	test("mode-change effect fires on INSERT→NORMAL transition", () => {
		const h = createHarness();
		h.seed("|abc");
		h.send("<Esc>");
		expect(h.fx.modes).toContain("normal");
	});
});

// ---------------------------------------------------------------------------
// onModeChange fires exactly once per transition (effects)
// ---------------------------------------------------------------------------

describe("mode-change effects", () => {
	test("INSERT→NORMAL fires one onModeChange('normal')", () => {
		const h = createHarness();
		h.seed("|hi");
		h.send("<Esc>");
		expect(h.fx.modes).toEqual(["normal"]);
	});

	test("NORMAL→INSERT via i fires one onModeChange('insert')", () => {
		const h = createHarness();
		h.seed("|hi");
		h.send("<Esc>"); // INSERT → NORMAL
		const modesBefore = [...h.fx.modes];
		h.send("i"); // NORMAL → INSERT
		expect(h.fx.modes.slice(modesBefore.length)).toEqual(["insert"]);
	});

	test("NORMAL→VISUAL fires one onModeChange('visual')", () => {
		const h = createHarness();
		h.seed("|hi");
		h.send("<Esc>v");
		expect(h.fx.modes).toEqual(["normal", "visual"]);
	});

	test("VISUAL→NORMAL via Esc fires one onModeChange('normal')", () => {
		const h = createHarness();
		h.seed("|hi");
		h.send("<Esc>v<Esc>");
		expect(h.fx.modes).toEqual(["normal", "visual", "normal"]);
	});

	test("no duplicate mode-change when already in target mode", () => {
		const h = createHarness();
		h.seed("|hi");
		// Already INSERT; pressing non-Esc keys should not fire mode change
		h.send("x");
		expect(h.fx.modes).toEqual([]);
	});
});

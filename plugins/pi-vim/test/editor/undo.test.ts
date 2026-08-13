/**
 * undo.test.ts — undo/redo timeline & granularity.
 *
 * All assertions are purely behavioural: we drive the editor through keystrokes
 * and check the resulting cursor-marker state.  We never access undo-stack
 * internals; the contract is "how many `u` presses return to a known state".
 *
 * Cursor-position rules used throughout:
 *  - The harness seeds the buffer in INSERT mode with the cursor AT the `|`.
 *  - `<Esc>` in INSERT shifts the cursor left one grapheme (vim: cursor rests
 *    ON a character), but only when col > 0.
 *  - Undo / redo restore the cursor to the snapshot taken at the START of the
 *    change, i.e. BEFORE the editing operation executed.
 */

import { describe, test, expect, createHarness } from "../support/harness.ts";

// ---------------------------------------------------------------------------
// u — single undo of the last NORMAL command
// ---------------------------------------------------------------------------

describe("u — basic undo of a NORMAL command", () => {
	test("x + u restores the deleted char", () => {
		// seed in INSERT at col 0; <Esc> with col=0 does NOT step left
		const h = createHarness();
		h.seed("|hello");
		h.send("<Esc>"); // cursor stays at col 0 (col was 0, no step)
		h.send("x"); // delete 'h' → "ello", cursor at col 0
		expect(h.state()).toBe("|ello");
		// snapshot before x: {text:"hello", line:0, col:0}
		h.send("u"); // restore → "hello", cursor at col 0
		expect(h.state()).toBe("|hello");
	});

	test("u is a no-op at the bottom of the stack", () => {
		const h = createHarness();
		h.seed("|hello");
		h.send("<Esc>"); // NORMAL, no change
		h.send("u"); // nothing to undo
		expect(h.state()).toBe("|hello");
	});
});

// ---------------------------------------------------------------------------
// One NORMAL command = one undo unit
// ---------------------------------------------------------------------------

describe("dw + u — whole word deletion is one undo unit", () => {
	// smoke test 29
	test("dw deletes a word; u restores it in a single press", () => {
		const h = createHarness();
		h.seed("|foo bar baz");
		h.send("<Esc>"); // col 0, no step
		h.send("dw"); // delete "foo " → "bar baz", cursor col 0
		expect(h.state()).toBe("|bar baz");
		// one u restores the whole dw (not char by char)
		h.send("u");
		expect(h.state()).toBe("|foo bar baz");
	});

	test("dw in the middle of the line; u restores cursor to pre-dw position", () => {
		const h = createHarness();
		h.seed("|the quick brown");
		// <Esc>: col=0 no step; ww: col moves to 10 (start of "brown"); dw: deletes "brown"
		// but wait — two `w` from col=0: first w→col=4 ("quick"), second w→col=10 ("brown")
		// snapshot before dw: {text:"the quick brown", col=10}
		h.send("<Esc>wwdw"); // move to "brown", delete it → "the quick "
		h.send("u"); // restores to {text:"the quick brown", col=10}
		// col=10 in "the quick brown" = 'b' in "brown"
		expect(h.state()).toBe("the quick |brown");
	});
});

describe("{count}x + u — counted delete is one undo unit", () => {
	// smoke test 30
	test("3x deletes 3 chars; u restores all in a single press", () => {
		const h = createHarness();
		h.seed("|abcdef");
		h.send("<Esc>"); // col 0
		h.send("3x"); // delete "abc" → "def", cursor col 0
		expect(h.state()).toBe("|def");
		// one u restores all three deleted chars
		h.send("u");
		expect(h.state()).toBe("|abcdef");
	});
});

describe("dd + u — linewise delete is one undo unit", () => {
	// smoke test 31
	test("dd deletes a line; u restores it in a single press", () => {
		const h = createHarness();
		h.seed("|one\ntwo\nthree");
		h.send("<Esc>gg"); // NORMAL, line 0 col 0
		h.send("dd"); // delete "one\n" → "two\nthree", cursor at line 0 col 0
		expect(h.state()).toBe("|two\nthree");
		h.send("u"); // snapshot before dd: {text:"one\ntwo\nthree", line:0, col:0}
		expect(h.state()).toBe("|one\ntwo\nthree");
	});
});

describe("2dd + u — counted linewise delete is one undo unit", () => {
	// smoke test 32
	test("2dd deletes 2 lines; u restores both in a single press", () => {
		const h = createHarness();
		h.seed("|a\nb\nc\nd");
		h.send("<Esc>gg");
		h.send("2dd"); // delete lines 0–1 → "c\nd", cursor at line 0 col 0
		expect(h.state()).toBe("|c\nd");
		h.send("u"); // snapshot before 2dd: {text:"a\nb\nc\nd", line:0, col:0}
		expect(h.state()).toBe("|a\nb\nc\nd");
	});
});

describe("dj + u — multi-line motion delete is one undo unit", () => {
	// smoke test 33
	test("dj deletes 2 lines; u restores both in a single press", () => {
		const h = createHarness();
		h.seed("|l1\nl2\nl3");
		h.send("<Esc>gg");
		h.send("dj"); // delete lines 0–1 → "l3", cursor at line 0 col 0
		expect(h.state()).toBe("|l3");
		h.send("u"); // snapshot before dj: {text:"l1\nl2\nl3", line:0, col:0}
		expect(h.state()).toBe("|l1\nl2\nl3");
	});
});

describe("dG + u — delete to last line is one undo unit", () => {
	// smoke test 34
	test("dG from line 1 deletes tail; u restores it in a single press", () => {
		const h = createHarness();
		h.seed("|a\nb\nc");
		// ESC from col 0 → no step; gg → line 0; j → line 1
		h.send("<Esc>ggj"); // cursor at line 1, col 0
		h.send("dG"); // delete lines 1–2 → "a", cursor past-end of "a"
		expect(h.state()).toBe("a|");
		// snapshot before dG: {text:"a\nb\nc", line:1, col:0}
		h.send("u");
		expect(h.state()).toBe("a\n|b\nc");
	});
});

// ---------------------------------------------------------------------------
// {count}u — multiple undos in one press
// ---------------------------------------------------------------------------

describe("{count}u — undo multiple steps at once", () => {
	test("2u undoes two distinct NORMAL commands", () => {
		const h = createHarness();
		h.seed("|abcdef");
		h.send("<Esc>");
		h.send("x"); // → "bcdef", snapshot 1: {text:"abcdef", col:0}
		h.send("x"); // → "cdef",  snapshot 2: {text:"bcdef", col:0}
		expect(h.state()).toBe("|cdef");
		h.send("2u"); // undo both x commands in one keystroke
		expect(h.state()).toBe("|abcdef");
	});
});

// ---------------------------------------------------------------------------
// <C-r> — redo
// ---------------------------------------------------------------------------

describe("<C-r> — redo an undone change", () => {
	// smoke test 35
	test("dw + u + <C-r> walks forward again", () => {
		const h = createHarness();
		h.seed("|hello world");
		h.send("<Esc>"); // col 0
		h.send("dw"); // → "world"
		h.send("u"); // → "hello world"
		expect(h.state()).toBe("|hello world");
		h.send("<C-r>"); // redo → "world"
		expect(h.state()).toBe("|world");
	});

	test("<C-r> is a no-op when the redo stack is empty", () => {
		const h = createHarness();
		h.seed("|hello");
		h.send("<Esc>");
		h.send("x"); // delete 'h' → "ello"
		// redo stack is empty (no prior undo)
		h.send("<C-r>"); // should be a no-op
		expect(h.state()).toBe("|ello");
	});
});

describe("{count}<C-r> — redo multiple steps at once", () => {
	test("2u then 2<C-r> returns to the same end state", () => {
		const h = createHarness();
		h.seed("|abcdef");
		h.send("<Esc>");
		h.send("x"); // → "bcdef", snapshot {text:"abcdef", col:0}
		h.send("x"); // → "cdef",  snapshot {text:"bcdef", col:0}
		h.send("2u"); // → "abcdef"
		expect(h.state()).toBe("|abcdef");
		h.send("2<C-r>"); // redo both → "cdef"
		expect(h.state()).toBe("|cdef");
	});
});

// ---------------------------------------------------------------------------
// New edit after undo clears the redo stack
// ---------------------------------------------------------------------------

describe("new edit after u clears redo stack", () => {
	// smoke test 36
	test("edit → u → edit2 → <C-r> is a no-op (redo stack cleared)", () => {
		const h = createHarness();
		h.seed("|abcdef");
		h.send("<Esc>"); // col 0
		h.send("x"); // → "bcdef"
		h.send("u"); // → "abcdef"; redo stack now has one entry
		h.send("x"); // new edit → "bcdef"; redo stack is cleared
		h.send("<C-r>"); // no-op (nothing to redo)
		// buffer must still be "bcdef" — <C-r> did not re-apply the original x
		expect(h.state()).toBe("|bcdef");
	});
});

// ---------------------------------------------------------------------------
// INSERT typing undoes character by character
// ---------------------------------------------------------------------------

describe("INSERT typing — each keystroke is its own undo unit", () => {
	// smoke test 37
	test("u drops one INSERT character at a time", () => {
		const h = createHarness();
		// "top" is already in the buffer; go to NORMAL and open a line below.
		// The 'o' command is one NORMAL undo unit (opens line + enters INSERT).
		h.seed("|top");
		h.send("<Esc>"); // col 0 (no step); NORMAL
		h.send("o"); // open line below, enter INSERT → buffer "top\n" committed
		// type 5 chars — each keystroke is its own undo unit
		h.send("added");
		h.send("<Esc>"); // step left from col 5 → col 4 (on last 'd')
		// "top\nadded", cursor at line 1, col 4
		expect(h.state()).toBe("top\nadde|d");

		// Undo the last 'd': restores to {text:"top\nadde", cursor at line1 col4}
		// (snapshot before that 'd' = col4 since the prior 'e' left cursor at col4)
		h.send("u");
		expect(h.state()).toBe("top\nadde|");

		// Undo 'e': restores to {text:"top\nadd", col3}
		h.send("u");
		expect(h.state()).toBe("top\nadd|");

		// Undo second 'd': restores to {text:"top\nad", col2}
		h.send("u");
		expect(h.state()).toBe("top\nad|");

		// Redo one char ('e' gets re-typed): restores to {text:"top\nadd", col3}
		h.send("<C-r>");
		expect(h.state()).toBe("top\nadd|");
	});
});

// ---------------------------------------------------------------------------
// Bracketed paste undoes as a single unit
// ---------------------------------------------------------------------------

describe("bracketed paste — whole paste is one undo unit", () => {
	// smoke test 38
	test("paste into empty buffer + u removes the entire paste; <C-r> restores it", () => {
		const h = createHarness();
		// editor starts in INSERT; seed empty buffer
		h.seed("|");
		// bracketed paste — one mutation, cursor ends at position 11 (past end)
		h.send("[paste]hello world[/paste]");
		expect(h.state()).toBe("hello world|");
		h.send("<Esc>"); // step left → col 10 (on 'd')
		h.send("u"); // snapshot before paste: {text:"", col:0} → empty buffer
		expect(h.state()).toBe("|");
		h.send("<C-r>"); // redo restores the whole paste; cursor at pre-undo pos
		// redo restores to the snapshot captured by undo: {text:"hello world", col:10}
		expect(h.state()).toBe("hello worl|d");
	});

	test("paste into non-empty buffer; u removes only the paste", () => {
		const h = createHarness();
		h.seed("pre|"); // INSERT, cursor col 3 (after 'e')
		// snapshot before paste: {text:"pre", col:3}
		h.send("[paste] appended[/paste]"); // → "pre appended", cursor past-end
		h.send("<Esc>"); // step left
		h.send("u"); // restore to {text:"pre", col:3}
		// col:3 in "pre" = past-end → renders as "pre|"
		expect(h.state()).toBe("pre|");
	});
});

// ---------------------------------------------------------------------------
// Multi-step undo/redo walks the timeline in order
// ---------------------------------------------------------------------------

describe("multi-step undo/redo — timeline order", () => {
	// smoke test 39
	test("two dw edits then two u/two <C-r> walk the full timeline", () => {
		const h = createHarness();
		h.seed("|w1 w2 w3");
		h.send("<Esc>"); // col 0
		h.send("dw"); // → "w2 w3"
		h.send("dw"); // → "w3"
		expect(h.state()).toBe("|w3");
		h.send("u"); // → "w2 w3"
		expect(h.state()).toBe("|w2 w3");
		h.send("u"); // → "w1 w2 w3"
		expect(h.state()).toBe("|w1 w2 w3");
		h.send("<C-r>"); // → "w2 w3"
		expect(h.state()).toBe("|w2 w3");
		h.send("<C-r>"); // → "w3"
		expect(h.state()).toBe("|w3");
	});

	test("three sequential x edits walk back and forth cleanly", () => {
		const h = createHarness();
		h.seed("|abcd");
		h.send("<Esc>");
		h.send("x"); // → "bcd",  snapshot {text:"abcd", col:0}
		h.send("x"); // → "cd",   snapshot {text:"bcd", col:0}
		h.send("x"); // → "d",    snapshot {text:"cd", col:0}
		expect(h.state()).toBe("|d");
		h.send("u"); // → "cd"
		expect(h.state()).toBe("|cd");
		h.send("u"); // → "bcd"
		expect(h.state()).toBe("|bcd");
		h.send("<C-r>"); // → "cd"
		expect(h.state()).toBe("|cd");
	});

	test("interleaved NORMAL and INSERT edits produce correct timeline", () => {
		const h = createHarness();
		h.seed("|");
		// NORMAL: 'i' enters INSERT (no text change, no undo unit)
		h.send("<Esc>i"); // INSERT
		h.send("ab"); // 2 undo units: 'a', 'b'
		// After typing 'b': buffer="ab", cursor col=2
		h.send("<Esc>"); // step left from col=2 → col=1 (on 'b'); NORMAL
		h.send("x"); // delete 'b' → "a"; deleteAbsRange moves cursor to lo=1 (past-end)
		expect(h.state()).toBe("a|"); // col=1 past-end of "a"
		h.send("u"); // restore to {text:"ab", col:1} → cursor on 'b'
		expect(h.state()).toBe("a|b");
		h.send("u"); // undo typing 'b': snapshot before 'b' = {text:"a", col:1}
		expect(h.state()).toBe("a|"); // col=1 past-end of "a"
		h.send("u"); // undo typing 'a': snapshot before 'a' = {text:"", col:0}
		expect(h.state()).toBe("|");
	});
});

// ---------------------------------------------------------------------------
// <C-r> decision: redo vs. prompt-history passthrough (4 cases)
// ---------------------------------------------------------------------------

describe("<C-r> — redo vs. prompt-history passthrough", () => {
	// Case 1: empty buffer, no vim history → forward to host (prompt history).
	test("empty buffer with no history forwards <C-r> to host history search", () => {
		const h = createHarness();
		let searches = 0;
		h.ed.onHistorySearch = () => { searches++; };
		h.seed("|"); // empty buffer, INSERT
		h.send("<Esc>"); // NORMAL, still empty, no history
		h.send("<C-r>");
		expect(searches).toBe(1);
		expect(h.state()).toBe("|"); // buffer untouched
	});

	// Case 2: text in the buffer → redo, never passthrough.
	test("non-empty buffer redoes and does NOT forward to host", () => {
		const h = createHarness();
		let searches = 0;
		h.ed.onHistorySearch = () => { searches++; };
		h.seed("|hello world");
		h.send("<Esc>");
		h.send("dw"); // → "world"
		h.send("u"); // → "hello world" (redo stack now has one entry)
		h.send("<C-r>"); // redo → "world"
		expect(h.state()).toBe("|world");
		expect(searches).toBe(0);
	});

	// Case 3: empty buffer but the vim timeline still has history → redo path
	// (a no-op here since the redo stack is empty), never passthrough.
	test("empty buffer with history redoes (no-op) and does NOT forward", () => {
		const h = createHarness();
		let searches = 0;
		h.ed.onHistorySearch = () => { searches++; };
		h.seed("|a");
		h.send("<Esc>");
		h.send("x"); // delete 'a' → "" (buffer empty, undo stack holds {text:"a"})
		expect(h.state()).toBe("|");
		h.send("<C-r>"); // history present → redo path (empty redo stack → no-op)
		expect(searches).toBe(0);
		expect(h.state()).toBe("|"); // still empty
	});

	// Case 4: empty buffer + history; Enter clears the vim timeline, then a
	// following <C-r> on the emptied buffer reaches prompt-history search.
	test("Enter clears vim history so the next <C-r> forwards to host", () => {
		const h = createHarness({ wireRunExCommand: false });
		let searches = 0;
		h.ed.onHistorySearch = () => { searches++; };
		h.seed("|a");
		h.send("<Esc>");
		h.send("x"); // → "" with history present
		h.send("<C-r>"); // history present → redo path, NOT passthrough
		expect(searches).toBe(0);
		h.send("<Enter>"); // submit: clears vim history + forwards (draft reset)
		expect(h.fx.submitted.length).toBeGreaterThan(0);
		h.send("<C-r>"); // empty buffer, history cleared → passthrough
		expect(searches).toBe(1);
	});

	// {count}<C-r> still consumes its count on the redo path.
	test("2<C-r> redoes two steps (count preserved through the decision)", () => {
		const h = createHarness();
		h.seed("|abcdef");
		h.send("<Esc>");
		h.send("x"); // → "bcdef"
		h.send("x"); // → "cdef"
		h.send("2u"); // → "abcdef"
		expect(h.state()).toBe("|abcdef");
		h.send("2<C-r>"); // redo both → "cdef"
		expect(h.state()).toBe("|cdef");
	});
});

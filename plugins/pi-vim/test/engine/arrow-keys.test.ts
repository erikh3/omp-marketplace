/**
 * test/engine/arrow-keys.test.ts
 *
 * Arrow keys in NORMAL / VISUAL modes. Two behaviours:
 *
 *  - On an empty prompt with no pending command, the raw arrow is forwarded to
 *    the base editor (INSERT parity), so the host's hooks fire — notably the
 *    double-tap-← agent-hub gesture (via `onLeftAtStart`) and ↑/↓ prompt
 *    history. Without this, the arrow was swallowed and the gesture only worked
 *    in INSERT mode.
 *  - With buffer content (or a pending command) the arrow acts as the
 *    equivalent `h`/`l`/`k`/`j` motion, composing with counts, operators, and
 *    visual-selection resize exactly like the letter keys.
 */

import { createHarness, describe, expect, test } from "../support/harness.ts";

describe("arrows on an empty prompt — forwarded to the host", () => {
	test("NORMAL ← fires onLeftAtStart (double-tap-← hub gesture)", () => {
		const h = createHarness();
		let leftTaps = 0;
		h.ed.onLeftAtStart = () => {
			leftTaps++;
		};
		h.send("<Esc>"); // empty buffer → NORMAL
		expect(h.ed.mode).toBe("normal");
		h.send("<Left>");
		h.send("<Left>");
		expect(leftTaps).toBe(2); // base editor saw both ← taps
	});

	test("VISUAL ← also forwards on an empty prompt", () => {
		const h = createHarness();
		let leftTaps = 0;
		h.ed.onLeftAtStart = () => {
			leftTaps++;
		};
		h.send("<Esc>");
		h.send("v"); // → VISUAL
		expect(h.ed.mode).toBe("visual");
		h.send("<Left>");
		expect(leftTaps).toBe(1);
	});

	test("↑/↓ on an empty prompt do not move the cursor or change mode", () => {
		const h = createHarness();
		h.send("<Esc>");
		h.send("<Up>");
		h.send("<Down>");
		expect(h.ed.mode).toBe("normal");
		expect(h.state()).toBe("|");
	});
});

describe("arrows as motions when the buffer has content", () => {
	test("← / → move like h / l", () => {
		const h = createHarness();
		h.seed("ab|cd"); // cursor on 'c'
		h.send("<Esc>"); // NORMAL: step left → 'b' (col 1)
		expect(h.state()).toBe("a|bcd");
		h.send("<Right>"); // → 'c'
		expect(h.state()).toBe("ab|cd");
		h.send("<Left>"); // → 'b'
		expect(h.state()).toBe("a|bcd");
	});

	test("↓ / ↑ move like j / k across lines", () => {
		const h = createHarness();
		h.seed("one\ntw|o\nthree"); // cursor starts on line 1 ("two")
		h.send("<Esc>"); // NORMAL, col 1 on line 1
		h.send("<Down>"); // → line 2 ("three"), col 1
		expect(h.state()).toBe("one\ntwo\nt|hree");
		h.send("<Up>"); // → back to line 1 ("two"), col 1
		expect(h.state()).toBe("one\nt|wo\nthree");
	});

	test("does NOT forward to the host once the buffer is non-empty", () => {
		const h = createHarness();
		let leftTaps = 0;
		h.ed.onLeftAtStart = () => {
			leftTaps++;
		};
		h.seed("ab|cd");
		h.send("<Esc>");
		h.send("<Left>"); // acts as `h`, a pure motion
		expect(leftTaps).toBe(0);
		expect(h.state()).toBe("|abcd");
	});

	test("{count}← composes like {count}h", () => {
		const h = createHarness();
		h.seed("abcde|");
		h.send("<Esc>"); // col 4 ('e')
		h.send("3<Left>"); // 3h → col 1 ('b')
		expect(h.state()).toBe("a|bcde");
	});
});

describe("arrows compose with operators and visual mode", () => {
	test("d→ deletes rightward like dl", () => {
		const h = createHarness();
		h.seed("ab|cd"); // cursor on 'c'
		h.send("<Esc>"); // → 'b' (col 1)
		h.send("d<Right>"); // dl → delete the char under the cursor ('b')
		expect(h.state()).toBe("a|cd");
	});

	test("v→ extends the selection like vl, then d deletes it", () => {
		const h = createHarness();
		h.seed("|abcd"); // cursor on 'a'
		h.send("<Esc>"); // col 0
		h.send("v"); // VISUAL, anchor on 'a'
		h.send("<Right>"); // extend to 'b'
		h.send("d"); // delete "ab"
		expect(h.ed.mode).toBe("normal");
		expect(h.state()).toBe("|cd");
	});
});

/**
 * test/editor/ex.test.ts
 *
 * Tests for the `:` ex command line in ModalVimEditor.
 * Covers: opening/closing ex, editing the buffer, quit family, known/reserved/unknown
 * commands, shell passthrough, prototype-chain guard, bracketed-paste safety, and
 * the guarantee that ex never touches the undo timeline.
 *
 * Behavior oracle: smoke.ts checks 47–60 and src/modal-editor.ts #handleEx /
 * #submitEx / #dispatchEx / #dispatchQuit.
 */

import { describe, expect, test } from "../support/harness.ts";
import { createHarness } from "../support/harness.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Open a fresh harness in NORMAL mode (Esc from INSERT). */
function h(commandNames: string[] = []) {
	const harness = createHarness({ commandNames });
	// Start every ex test in NORMAL mode.
	harness.send("<Esc>");
	return harness;
}

// ---------------------------------------------------------------------------
// 1. Opening ex / buffer editing
// ---------------------------------------------------------------------------

describe(": opens ex mode", () => {
	test("`:` emits `:` as the ex command and keeps mode NORMAL", () => {
		const { ed, fx } = h();
		ed.handleInput(":");
		// ex is a sub-state of NORMAL; VimMode stays "normal"
		expect(ed.mode).toBe("normal");
		expect(fx.exCommands.at(-1)).toBe(":");
	});

	test("typing after `:` extends the ex buffer", () => {
		const { ed, fx } = h();
		ed.handleInput(":");
		ed.handleInput("q");
		expect(fx.exCommands.at(-1)).toBe(":q");
	});

	test("multiple chars accumulate", () => {
		const { ed, fx } = h();
		ed.handleInput(":");
		"quit".split("").forEach(c => ed.handleInput(c));
		expect(fx.exCommands.at(-1)).toBe(":quit");
	});
});

// ---------------------------------------------------------------------------
// 2. Closing ex — Esc / Backspace
// ---------------------------------------------------------------------------

describe("<Esc> cancels ex", () => {
	test("Esc clears the ex buffer (emits null)", () => {
		const { ed, fx } = h();
		ed.handleInput(":");
		ed.handleInput("q");
		ed.handleInput("\x1b"); // Esc
		expect(fx.exCommands.at(-1)).toBeNull();
	});

	test("mode is still NORMAL after Esc", () => {
		const { ed } = h();
		ed.handleInput(":");
		ed.handleInput("\x1b");
		expect(ed.mode).toBe("normal");
	});
});

describe("<BS> on ex buffer", () => {
	test("<BS> on bare `:` exits ex (emits null)", () => {
		const { ed, fx } = h();
		ed.handleInput(":");
		ed.handleInput("\x7f"); // backspace
		expect(fx.exCommands.at(-1)).toBeNull();
	});

	test("<BS> after one char drops that char, stays in ex", () => {
		const { ed, fx } = h();
		ed.handleInput(":");
		"qa".split("").forEach(c => ed.handleInput(c));
		ed.handleInput("\x7f");
		expect(fx.exCommands.at(-1)).toBe(":q");
	});

	test("<BS> via DSL notation", () => {
		const { fx, send } = h();
		send(":qa<BS>");
		expect(fx.exCommands.at(-1)).toBe(":q");
	});
});

// ---------------------------------------------------------------------------
// 3. Quit family — :q :qa :quit :qall :quitall
// ---------------------------------------------------------------------------

describe("quit family on empty prompt", () => {
	for (const cmd of ["q", "qa", "quit", "qall", "quitall"]) {
		test(`:${cmd} dispatches /quit on empty buffer`, () => {
			const { ed, fx } = h();
			// buffer is already empty (fresh editor, Esc doesn't add text)
			cmd.split("").forEach(c => ed.handleInput(":"));
			// reset and send properly
			const { ed: ed2, fx: fx2 } = h();
			ed2.handleInput(":");
			cmd.split("").forEach(c => ed2.handleInput(c));
			ed2.handleInput("\r"); // CR submits
			expect(fx2.dispatched).toContain("/quit");
			expect(fx2.exCommands.at(-1)).toBeNull(); // ex cleared after submit
		});
	}
});

// More precise quit tests using the send() helper:
describe("quit family: exact dispatch behavior", () => {
	test(":q on empty prompt dispatches /quit", () => {
		const { fx, send } = h();
		send(":q<CR>");
		expect(fx.dispatched.at(-1)).toBe("/quit");
	});

	test(":qa on empty prompt dispatches /quit", () => {
		const { fx, send } = h();
		send(":qa<CR>");
		expect(fx.dispatched.at(-1)).toBe("/quit");
	});

	test(":quit on empty prompt dispatches /quit", () => {
		const { fx, send } = h();
		send(":quit<CR>");
		expect(fx.dispatched.at(-1)).toBe("/quit");
	});

	test(":qall on empty prompt dispatches /quit", () => {
		const { fx, send } = h();
		send(":qall<CR>");
		expect(fx.dispatched.at(-1)).toBe("/quit");
	});

	test(":quitall on empty prompt dispatches /quit", () => {
		const { fx, send } = h();
		send(":quitall<CR>");
		expect(fx.dispatched.at(-1)).toBe("/quit");
	});

	test("ex mode is cleared after a quit dispatch", () => {
		const { fx, send } = h();
		send(":q<CR>");
		expect(fx.exCommands.at(-1)).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// 4. Quit on non-empty prompt (dirty-prompt guard)
// ---------------------------------------------------------------------------

describe("quit family: dirty-prompt guard", () => {
	test(":q on non-empty prompt warns (message includes 'not empty')", () => {
		const { ed, fx } = h();
		// Type some text while in INSERT mode then escape
		ed.handleInput("\x1b"); // back to insert from normal (was already in normal via h())
		// Actually: h() does Esc once, editor starts in INSERT, then Esc goes to NORMAL.
		// We need to seed some text first.
		const { ed: ed2, fx: fx2, send: send2 } = createHarness();
		// type in INSERT
		"draft text".split("").forEach(c => ed2.handleInput(c));
		// go NORMAL
		ed2.handleInput("\x1b");
		// try :q
		send2(":q<CR>");
		expect(fx2.notifications.at(-1)).toMatch(/not empty/i);
	});

	test(":q on non-empty prompt does NOT dispatch /quit", () => {
		const { ed: ed2, fx: fx2, send: send2 } = createHarness();
		"draft text".split("").forEach(c => ed2.handleInput(c));
		ed2.handleInput("\x1b");
		send2(":q<CR>");
		expect(fx2.dispatched).not.toContain("/quit");
	});

	test(":q on non-empty prompt preserves the draft buffer", () => {
		const { ed: ed2, fx: fx2, send: send2 } = createHarness();
		"draft text".split("").forEach(c => ed2.handleInput(c));
		ed2.handleInput("\x1b");
		send2(":q<CR>");
		expect(ed2.getText()).toBe("draft text");
	});

	test(":qa on non-empty prompt also warns and does not quit", () => {
		const { ed: ed2, fx: fx2, send: send2 } = createHarness();
		"content".split("").forEach(c => ed2.handleInput(c));
		ed2.handleInput("\x1b");
		send2(":qa<CR>");
		expect(fx2.dispatched).not.toContain("/quit");
		expect(fx2.notifications.at(-1)).toMatch(/not empty/i);
	});
});

// ---------------------------------------------------------------------------
// 5. Force-quit :q! — overrides dirty-prompt guard
// ---------------------------------------------------------------------------

describe("force-quit :q!", () => {
	test(":q! dispatches /quit even on a non-empty prompt", () => {
		const { ed: ed2, fx: fx2, send: send2 } = createHarness();
		"draft".split("").forEach(c => ed2.handleInput(c));
		ed2.handleInput("\x1b");
		send2(":q!<CR>");
		expect(fx2.dispatched.at(-1)).toBe("/quit");
	});

	test(":qa! force-quits on a dirty prompt", () => {
		const { ed: ed2, fx: fx2, send: send2 } = createHarness();
		"draft".split("").forEach(c => ed2.handleInput(c));
		ed2.handleInput("\x1b");
		send2(":qa!<CR>");
		expect(fx2.dispatched.at(-1)).toBe("/quit");
	});

	test(":quit! force-quits on a dirty prompt", () => {
		const { ed: ed2, fx: fx2, send: send2 } = createHarness();
		"draft".split("").forEach(c => ed2.handleInput(c));
		ed2.handleInput("\x1b");
		send2(":quit!<CR>");
		expect(fx2.dispatched.at(-1)).toBe("/quit");
	});
});

// ---------------------------------------------------------------------------
// 6. Known slash commands — dispatch + draft restore
// ---------------------------------------------------------------------------

describe("known command dispatch", () => {
	test("`:tree` dispatches `/tree` when 'tree' is a known command", () => {
		const { fx, send } = createHarness({ commandNames: ["tree"] });
		send("<Esc>:tree<CR>");
		expect(fx.dispatched).toEqual(["/tree"]);
	});

	test("dispatch restores the draft buffer content", () => {
		const { ed, send } = createHarness({ commandNames: ["tree"] });
		// seed draft
		"my prompt".split("").forEach(c => ed.handleInput(c));
		ed.handleInput("\x1b");
		send(":tree<CR>");
		expect(ed.getText()).toBe("my prompt");
	});

	test("dispatch clears ex mode (emits null)", () => {
		const { fx, send } = createHarness({ commandNames: ["tree"] });
		send("<Esc>:tree<CR>");
		expect(fx.exCommands.at(-1)).toBeNull();
	});

	test("args after whitespace pass through: `:model opus` → `/model opus`", () => {
		const { fx, send } = createHarness({ commandNames: ["model"] });
		send("<Esc>:model opus<CR>");
		expect(fx.dispatched).toEqual(["/model opus"]);
	});

	test("multiple args words pass through verbatim", () => {
		const { fx, send } = createHarness({ commandNames: ["ask"] });
		send("<Esc>:ask what is this<CR>");
		expect(fx.dispatched).toEqual(["/ask what is this"]);
	});

	test("command name with trailing whitespace still matches", () => {
		// `:model  opus` — extra space is trimmed in args but name is still "model"
		const { fx, send } = createHarness({ commandNames: ["model"] });
		send("<Esc>:model  opus<CR>");
		// The editor splits on first whitespace: name="model", args="opus" (trimmed)
		expect(fx.dispatched).toEqual(["/model opus"]);
	});
});

// ---------------------------------------------------------------------------
// 7. Shell passthrough — :!cmd / :!!cmd
// ---------------------------------------------------------------------------

describe("shell passthrough :!cmd", () => {
	test("`:!ls` dispatches `!ls` verbatim", () => {
		const { fx, send } = h();
		send(":!ls<CR>");
		expect(fx.dispatched.at(-1)).toBe("!ls");
	});

	test("`:!!git status` dispatches `!!git status` verbatim", () => {
		const { fx, send } = h();
		send(":!!git status<CR>");
		expect(fx.dispatched.at(-1)).toBe("!!git status");
	});

	test("bare `:!` (no command) notifies 'Unsupported'", () => {
		const { fx, send } = h();
		send(":!<CR>");
		expect(fx.notifications.at(-1)).toMatch(/unsupported/i);
	});

	test("bare `:!` does NOT dispatch anything", () => {
		const { fx, send } = h();
		send(":!<CR>");
		expect(fx.dispatched).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// 8. Reserved names — :s :g :w :d (never dispatch)
// ---------------------------------------------------------------------------

describe("reserved ex commands", () => {
	for (const cmd of ["s", "g", "w", "d"]) {
		test(`:${cmd} notifies 'Reserved'`, () => {
			const { fx, send } = h();
			send(`:${cmd}<CR>`);
			expect(fx.notifications.at(-1)).toMatch(/reserved/i);
		});

		test(`:${cmd} never dispatches`, () => {
			const { fx, send } = h();
			send(`:${cmd}<CR>`);
			expect(fx.dispatched).toEqual([]);
		});
	}

	test(":w reserved even when a command named 'w' is registered", () => {
		// Reserved takes precedence over known commands (smoke.ts check 56)
		const { fx, send } = createHarness({ commandNames: ["w"] });
		send("<Esc>:w<CR>");
		expect(fx.dispatched).toEqual([]);
		expect(fx.notifications.at(-1)).toMatch(/reserved/i);
	});
});

// ---------------------------------------------------------------------------
// 9. Prototype-chain names — must NOT be treated as quit or reserved
// ---------------------------------------------------------------------------

describe("prototype-chain name guard (Object.hasOwn)", () => {
	test("`:toString` does not trigger quit dispatch", () => {
		const { fx, send } = h();
		send(":toString<CR>");
		expect(fx.dispatched).not.toContain("/quit");
	});

	test("`:toString` falls through to unknown → notifies 'Unsupported'", () => {
		const { fx, send } = h();
		send(":toString<CR>");
		expect(fx.notifications.at(-1)).toMatch(/unsupported/i);
	});

	test("`:constructor` is not treated as reserved", () => {
		const { fx, send } = h();
		send(":constructor<CR>");
		// Should notify unsupported, not reserved
		expect(fx.notifications.at(-1)).toMatch(/unsupported/i);
		expect(fx.dispatched).toEqual([]);
	});

	test("`:hasOwnProperty` falls through to unknown/notify", () => {
		const { fx, send } = h();
		send(":hasOwnProperty<CR>");
		expect(fx.notifications.at(-1)).toMatch(/unsupported/i);
		expect(fx.dispatched).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// 10. Unknown command — notifies
// ---------------------------------------------------------------------------

describe("unknown command", () => {
	test("unknown command notifies 'Unsupported'", () => {
		const { fx, send } = createHarness({ commandNames: ["tree"] });
		send("<Esc>:frobnicate<CR>");
		expect(fx.notifications.at(-1)).toMatch(/unsupported/i);
	});

	test("unknown command does not dispatch anything", () => {
		const { fx, send } = createHarness({ commandNames: ["tree"] });
		send("<Esc>:frobnicate<CR>");
		expect(fx.dispatched).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// 11. Pasted newline in ex never auto-submits
// ---------------------------------------------------------------------------

describe("bracketed paste in ex mode", () => {
	test("pasted content with embedded newline: only first line is kept", () => {
		const { fx, send } = createHarness({ commandNames: ["tree"] });
		send("<Esc>:");
		// inject bracketed paste with embedded newline
		send("[paste]tree\nrest[/paste]");
		expect(fx.exCommands.at(-1)).toBe(":tree");
	});

	test("pasted newline does not auto-submit (nothing dispatched)", () => {
		const { fx, send } = createHarness({ commandNames: ["tree"] });
		send("<Esc>:");
		send("[paste]tree\nrest[/paste]");
		// No CR was sent; no dispatch should have happened
		expect(fx.dispatched).toEqual([]);
	});

	test("a typed <CR> after paste DOES submit", () => {
		const { fx, send } = createHarness({ commandNames: ["tree"] });
		send("<Esc>:");
		send("[paste]tree\nrest[/paste]");
		send("<CR>");
		expect(fx.dispatched).toEqual(["/tree"]);
	});
});

// ---------------------------------------------------------------------------
// 12. Ex editing never touches the undo timeline
// ---------------------------------------------------------------------------

describe("ex does not touch the undo timeline", () => {
	test("u after ex dispatch reverts the real pre-ex edit, not an ex artifact", () => {
		// Smoke test 60: type "hello", Esc, x (delete 'o' → "hell"), :tree<CR>, u → "hello"
		const { ed, send } = createHarness({ commandNames: ["tree"] });
		// type "hello" in INSERT
		"hello".split("").forEach(c => ed.handleInput(c));
		// go NORMAL
		ed.handleInput("\x1b");
		// delete the last char ('o') → "hell"
		ed.handleInput("x");
		expect(ed.getText()).toBe("hell");
		// run an ex command (should not add an undo entry)
		send(":tree<CR>");
		// undo should revert the `x`, restoring "hello"
		ed.handleInput("u");
		expect(ed.getText()).toBe("hello");
	});

	test("cancelling ex (Esc) also does not add an undo entry", () => {
		const { ed, send } = createHarness();
		"hello".split("").forEach(c => ed.handleInput(c));
		ed.handleInput("\x1b");
		ed.handleInput("x"); // delete last char → "hell"
		// open ex and cancel it
		send(":model<Esc>");
		// undo should revert the `x`
		ed.handleInput("u");
		expect(ed.getText()).toBe("hello");
	});
});

// ---------------------------------------------------------------------------
// 13. Empty command (bare <CR> on `:`) — no-op
// ---------------------------------------------------------------------------

describe("empty ex submit is a no-op", () => {
	test("`:` then `<CR>` immediately does not dispatch anything", () => {
		// `:` then trim → empty → submitEx returns early
		// Note: handleEx routes \r through #submitEx, but first #clearEx is called,
		// then command = "".trim() → early return.
		// However the harness does not expose the ex state after submit; we just assert
		// no dispatch and no notification.
		const { fx, send } = h();
		send(":<CR>");
		expect(fx.dispatched).toEqual([]);
		expect(fx.notifications).toEqual([]);
	});
});

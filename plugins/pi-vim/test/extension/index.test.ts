/**
 * Extension wiring tests for piVim(pi).
 *
 * Builds a mock ExtensionAPI and UI ctx, invokes piVim, fires the captured
 * session_start / session_shutdown handlers, and asserts all observable wiring
 * contracts: editor factory, callbacks, cursor shapes, widget mount, and
 * shutdown cleanup.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ExtensionAPI, ExtensionContext, ExtensionUIContext, AppKeybinding, Theme } from "@oh-my-pi/pi-coding-agent";
import { theme } from "@oh-my-pi/pi-coding-agent";
import type { EditorTheme } from "@oh-my-pi/pi-tui";
import { ModalVimEditor } from "../../src/modal-editor.ts";
import piVim from "../../src/index.ts";

// ---------------------------------------------------------------------------
// Minimal stub types
// ---------------------------------------------------------------------------

/** Subset of Theme needed by the widget factory and editor factory. */
const themeStub = {
	borderColor: (s: string) => s,
	fg: (_color: unknown, s: string) => s,
	bg: (_color: unknown, s: string) => s,
	getColorMode: () => "truecolor",
} as unknown as Theme;

/** Minimal EditorTheme for the editor factory. */
const editorThemeStub = {
	borderColor: (s: string) => s,
	symbols: {} as unknown,
} as unknown as EditorTheme;

/** Minimal KeybindingsManager — editor ignores it in headless use. */
const keybindingsStub = {} as unknown as AppKeybinding;

// ---------------------------------------------------------------------------
// Mock factory
// ---------------------------------------------------------------------------

type HandlerMap = Map<string, (event: unknown, ctx: ExtensionContext) => Promise<void>>;

function makeMocks() {
	const handlers: HandlerMap = new Map();

	/** Captured setEditorComponent calls. */
	const editorFactories: Array<((tui: unknown, theme: unknown, kb: unknown) => ModalVimEditor) | undefined> = [];
	/** Captured setWidget calls: { key, factory|undefined, opts } */
	const widgetCalls: Array<{ key: string; content: unknown; opts: unknown }> = [];
	/** Captured notify calls: { message, level } */
	const notifyCalls: Array<{ message: string; level: string | undefined }> = [];
	/** Captured sendUserMessage calls. */
	const userMessages: string[] = [];

	const ui: Partial<ExtensionUIContext> & {
		setEditorComponent: (f: unknown) => void;
		setWidget: (key: string, content: unknown, opts?: unknown) => void;
		notify: (message: string, type?: string) => void;
	} = {
		setEditorComponent(factory: unknown) {
			editorFactories.push(factory as ((tui: unknown, theme: unknown, kb: unknown) => ModalVimEditor) | undefined);
		},
		setWidget(key: string, content: unknown, opts?: unknown) {
			widgetCalls.push({ key, content, opts });
		},
		notify(message: string, type?: string) {
			notifyCalls.push({ message, level: type });
		},
		// Provide a theme so the factory can read it
		get theme() {
			return themeStub;
		},
	};

	/** Build a UI ctx with a given hasUI flag. */
	function makeCtx(hasUI: boolean): ExtensionContext {
		return {
			hasUI,
			ui: hasUI ? (ui as unknown as ExtensionUIContext) : (undefined as unknown as ExtensionUIContext),
		} as unknown as ExtensionContext;
	}

	const pi = {
		on(event: string, handler: (e: unknown, ctx: ExtensionContext) => Promise<void>) {
			handlers.set(event, handler);
		},
		logger: {
			debug: () => {},
			info: () => {},
			warn: () => {},
			error: () => {},
		},
		getCommands() {
			return [{ name: "tree" }];
		},
		sendUserMessage(content: string) {
			userMessages.push(content);
		},
		// Event bus used by the mode-change effects handler.
		events: { emit: () => {}, on: () => () => {}, clear: () => {} },
		// Shell exec used by modeChange hooks (no hooks configured in tests).
		exec: async () => ({ code: 0, stdout: "", stderr: "" }),
	} as unknown as ExtensionAPI;

	/**
	 * Invoke the captured handler for an event.
	 * Returns the editor instance after calling setEditorComponent when
	 * the factory was invoked during session_start.
	 */
	async function fireStart(hasUI: boolean): Promise<ModalVimEditor | undefined> {
		const handler = handlers.get("session_start");
		if (!handler) throw new Error("session_start handler not registered");
		const ctx = makeCtx(hasUI);
		await handler({}, ctx);
		// Invoke the most recently captured factory to obtain the editor.
		const factory = editorFactories.at(-1);
		if (typeof factory === "function") {
			return factory(undefined, editorThemeStub, keybindingsStub);
		}
		return undefined;
	}

	async function fireShutdown(hasUI: boolean): Promise<void> {
		const handler = handlers.get("session_shutdown");
		if (!handler) throw new Error("session_shutdown handler not registered");
		await handler({}, makeCtx(hasUI));
	}

	return {
		pi,
		ui,
		handlers,
		editorFactories,
		widgetCalls,
		notifyCalls,
		userMessages,
		fireStart,
		fireShutdown,
	};
}

// ---------------------------------------------------------------------------
// stdout capture
// ---------------------------------------------------------------------------

let stdoutWrites: string[] = [];
let originalWrite: typeof process.stdout.write;

beforeEach(() => {
	stdoutWrites = [];
	originalWrite = process.stdout.write.bind(process.stdout);
	process.stdout.write = (chunk: string | Uint8Array, ...rest: unknown[]) => {
		if (typeof chunk === "string") stdoutWrites.push(chunk);
		return true;
	};
});

afterEach(() => {
	process.stdout.write = originalWrite;
});

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("piVim extension wiring", () => {
	// -----------------------------------------------------------------------
	// Registration phase
	// -----------------------------------------------------------------------

	test("registers session_start and session_shutdown handlers", () => {
		const { pi, handlers } = makeMocks();
		piVim(pi);
		expect(handlers.has("session_start")).toBe(true);
		expect(handlers.has("session_shutdown")).toBe(true);
	});

	// -----------------------------------------------------------------------
	// session_start with hasUI = true
	// -----------------------------------------------------------------------

	describe("session_start (hasUI = true)", () => {
		test("setEditorComponent is called and factory returns a ModalVimEditor", async () => {
			const { pi, editorFactories, fireStart } = makeMocks();
			piVim(pi);
			const editor = await fireStart(true);
			expect(editorFactories.length).toBeGreaterThanOrEqual(1);
			expect(editor).toBeInstanceOf(ModalVimEditor);
		});

		test("the four host callbacks are wired on the returned editor", async () => {
			const { pi, fireStart } = makeMocks();
			piVim(pi);
			const editor = (await fireStart(true))!;
			expect(typeof editor.onModeChange).toBe("function");
			expect(typeof editor.onExCommandChange).toBe("function");
			expect(typeof editor.notifyUser).toBe("function");
			expect(typeof editor.getCommandNames).toBe("function");
			// `runExCommand` is deliberately LEFT UNSET so the editor's ex dispatch
			// falls through to `setText` + `onSubmit` — the host's real submit
			// pipeline, which interprets slash commands and `!` shell. Wiring it to
			// `pi.sendUserMessage` (an earlier build) sent `:tree`/`!ls` to the LLM
			// as literal text instead of executing them.
			expect(editor.runExCommand).toBeUndefined();
		});

		test("ex dispatch routes through the editor's onSubmit, not sendUserMessage", async () => {
			const { pi, userMessages, fireStart } = makeMocks();
			piVim(pi);
			const editor = (await fireStart(true))!;
			// Simulate the host wiring onSubmit onto the editor (as
			// InputController.setupEditorSubmitHandler does).
			const submitted: string[] = [];
			editor.onSubmit = (text: string) => { submitted.push(text); };
			// Type `:tree`<Enter> in NORMAL mode.
			editor.handleInput("\x1b"); // -> NORMAL
			for (const ch of ":tree") editor.handleInput(ch);
			editor.handleInput("\r"); // submit ex line
			// The command line reached the submit pipeline as a slash command…
			expect(submitted).toContain("/tree");
			// …and was NOT sent to the LLM as a user prompt.
			expect(userMessages).not.toContain("/tree");
			expect(userMessages).not.toContain(":tree");
		});

		test("notifyUser routes to ctx.ui.notify with 'warning' level", async () => {
			const { pi, notifyCalls, fireStart } = makeMocks();
			piVim(pi);
			// We need to fire the start handler and capture the editor from the factory
			// but the factory is invoked inside session_start to get callbacks bound.
			// Re-invoke the factory (second call) to get another editor; callbacks
			// close over the same ctx, so just read the first editor from fireStart.
			const editor = (await fireStart(true))!;
			editor.notifyUser!("test-message");
			expect(notifyCalls).toContainEqual({ message: "test-message", level: "warning" });
		});

		test("INSERT mode applied on install: widget mounted belowEditor and INSERT cursor shape written", async () => {
			const { pi, widgetCalls, fireStart } = makeMocks();
			piVim(pi);
			await fireStart(true);
			// Widget must have been mounted with belowEditor placement
			const insertWidget = widgetCalls.find(
				(c) => c.key === "pi-vim-mode" && (c.opts as { placement?: string })?.placement === "belowEditor",
			);
			expect(insertWidget).toBeDefined();
			// INSERT cursor shape: blinking bar
			expect(stdoutWrites).toContain("\x1b[5 q");
		});

		test("driving editor to NORMAL writes NORMAL cursor shape and re-asserts widget", async () => {
			const { pi, widgetCalls, fireStart } = makeMocks();
			piVim(pi);
			const editor = (await fireStart(true))!;
			const widgetCountBefore = widgetCalls.length;
			// Trigger mode change to normal
			editor.onModeChange!("normal");
			// NORMAL cursor shape: steady block
			expect(stdoutWrites).toContain("\x1b[2 q");
			// widget re-asserted
			expect(widgetCalls.length).toBeGreaterThan(widgetCountBefore);
			const lastWidget = widgetCalls.at(-1)!;
			expect(lastWidget.key).toBe("pi-vim-mode");
			expect((lastWidget.opts as { placement?: string })?.placement).toBe("belowEditor");
		});

		test("ex-command change writes block cursor shape", async () => {
			const { pi, widgetCalls, fireStart } = makeMocks();
			piVim(pi);
			const editor = (await fireStart(true))!;
			stdoutWrites = []; // reset after install
			editor.onExCommandChange!(":q");
			// Block shape during ex mode
			expect(stdoutWrites).toContain("\x1b[2 q");
			// widget re-asserted
			expect(widgetCalls.some((c) => c.key === "pi-vim-mode")).toBe(true);
		});

		test("clearing ex-command restores the mode cursor shape", async () => {
			const { pi, fireStart } = makeMocks();
			piVim(pi);
			const editor = (await fireStart(true))!;
			// Set to normal first so current mode is normal
			editor.onModeChange!("normal");
			stdoutWrites = []; // reset
			// Simulate clearing ex command (null)
			editor.onExCommandChange!(null);
			// Should restore normal shape (steady block)
			expect(stdoutWrites).toContain("\x1b[2 q");
		});

		test("clearing ex-command from INSERT mode restores INSERT cursor shape", async () => {
			const { pi, fireStart } = makeMocks();
			piVim(pi);
			const editor = (await fireStart(true))!;
			// currentMode starts as insert after install
			stdoutWrites = []; // reset after install
			editor.onExCommandChange!(":w"); // start ex
			stdoutWrites = []; // reset
			editor.onExCommandChange!(null); // clear
			// Should restore insert shape (blinking bar)
			expect(stdoutWrites).toContain("\x1b[5 q");
		});
	});

	// -----------------------------------------------------------------------
	// session_shutdown
	// -----------------------------------------------------------------------

	describe("session_shutdown (hasUI = true)", () => {
		test("clears the widget and restores default editor", async () => {
			const { pi, widgetCalls, editorFactories, fireStart, fireShutdown } = makeMocks();
			piVim(pi);
			await fireStart(true);
			await fireShutdown(true);
			// Widget cleared: setWidget called with undefined content
			const clearCall = widgetCalls.find((c) => c.key === "pi-vim-mode" && c.content === undefined);
			expect(clearCall).toBeDefined();
			// setEditorComponent called with undefined to restore default
			expect(editorFactories).toContain(undefined);
		});

		test("throw from setEditorComponent(undefined) is swallowed", async () => {
			const { pi, ui, fireStart, fireShutdown } = makeMocks();
			piVim(pi);
			await fireStart(true);
			// Make setEditorComponent throw on the undefined call
			let callCount = 0;
			ui.setEditorComponent = (f: unknown) => {
				callCount++;
				if (f === undefined) throw new Error("simulated tear-down error");
			};
			// Must not throw
			await expect(fireShutdown(true)).resolves.toBeUndefined();
		});
	});

	// -----------------------------------------------------------------------
	// hasUI = false short-circuit
	// -----------------------------------------------------------------------

	describe("hasUI = false", () => {
		test("session_start short-circuits: no setEditorComponent or setWidget calls", async () => {
			const { pi, editorFactories, widgetCalls, fireStart } = makeMocks();
			piVim(pi);
			await fireStart(false);
			expect(editorFactories).toHaveLength(0);
			expect(widgetCalls).toHaveLength(0);
		});

		test("session_shutdown short-circuits: no setEditorComponent or setWidget calls", async () => {
			const { pi, editorFactories, widgetCalls, fireShutdown } = makeMocks();
			piVim(pi);
			await fireShutdown(false);
			expect(editorFactories).toHaveLength(0);
			expect(widgetCalls).toHaveLength(0);
		});
	});

	// -----------------------------------------------------------------------
	// getCommandNames includes BUILTIN_SLASH_COMMAND_RESERVED_NAMES
	// -----------------------------------------------------------------------

	test("getCommandNames returns a Set that is not empty (includes builtins)", async () => {
		const { pi, fireStart } = makeMocks();
		piVim(pi);
		const editor = (await fireStart(true))!;
		const names = editor.getCommandNames!();
		expect(names).toBeInstanceOf(Set);
		expect(names.size).toBeGreaterThan(0);
	});

	// -----------------------------------------------------------------------
	// Cursor shapes per mode
	// -----------------------------------------------------------------------

	describe("cursor shapes", () => {
		test("VISUAL mode writes block cursor shape (\\x1b[2 q)", async () => {
			const { pi, fireStart } = makeMocks();
			piVim(pi);
			const editor = (await fireStart(true))!;
			stdoutWrites = [];
			editor.onModeChange!("visual");
			expect(stdoutWrites).toContain("\x1b[2 q");
		});

		test("VISUAL-LINE mode writes block cursor shape (\\x1b[2 q)", async () => {
			const { pi, fireStart } = makeMocks();
			piVim(pi);
			const editor = (await fireStart(true))!;
			stdoutWrites = [];
			editor.onModeChange!("visual-line");
			expect(stdoutWrites).toContain("\x1b[2 q");
		});

		test("INSERT mode writes blinking bar cursor shape (\\x1b[5 q)", async () => {
			const { pi, fireStart } = makeMocks();
			piVim(pi);
			const editor = (await fireStart(true))!;
			// Go to normal first, then back to insert
			editor.onModeChange!("normal");
			stdoutWrites = [];
			editor.onModeChange!("insert");
			expect(stdoutWrites).toContain("\x1b[5 q");
		});
	});
});

// ---------------------------------------------------------------------------
// Regression: magic-keyword rendering must not crash under the extension's
// own module instance of the coding-agent source graph.
//
// The extension package's `main` is `src/index.ts`, so loading pi-vim pulls in
// a SECOND module instance of the coding-agent source, separate from the
// running `dist/cli.js` bundle. That instance's global `theme` is never
// initialised by the host, so the magic-keyword gradient highlighter reached
// from the editor's `decorateText` (`palette()` -> `theme.getColorMode()`)
// threw "undefined is not an object" and crashed the render loop the moment a
// magic keyword ("ultrathink", "orchestrate", "workflowz") appeared in the
// prompt. session_start now adopts the host's live theme instance (from
// ctx.ui.theme) so the render path resolves the host's real color mode.
// ---------------------------------------------------------------------------

/** Strip SGR color escapes so the visible text can be asserted. */
function stripAnsi(s: string): string {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: matching ANSI SGR escapes.
	return s.replace(/\x1b\[[0-9;]*m/g, "");
}

describe("piVim magic-keyword theme init", () => {
	test("session_start adopts the host's live theme instance", async () => {
		const { pi, fireStart } = makeMocks();
		piVim(pi);
		await fireStart(true);
		// The extension must share the host's actual theme object (from
		// ctx.ui.theme), not a separately re-detected default, so the gradient
		// highlighter's `theme.getColorMode()` resolves the host's real mode.
		expect(theme).toBe(themeStub);
		expect(typeof theme.getColorMode).toBe("function");
	});

	test.each(["ultrathink", "orchestrate", "workflowz"])(
		"decorating %s through the editor does not throw after start",
		async (keyword) => {
			const { pi, fireStart } = makeMocks();
			piVim(pi);
			const editor = (await fireStart(true))!;
			// This is the exact path that crashed: the editor's decorateText hook
			// runs the magic-keyword gradient highlighter, which calls
			// `theme.getColorMode()`. Before the fix this threw a TypeError.
			let decorated = "";
			expect(() => {
				decorated = editor.decorateText(keyword);
			}).not.toThrow();
			// The gradient injects only zero-width SGR escapes, so the visible
			// text is unchanged once the color codes are stripped.
			expect(stripAnsi(decorated)).toContain(keyword);
		},
	);
});

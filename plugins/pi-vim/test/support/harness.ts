/**
 * Headless test harness for {@link ModalVimEditor}.
 *
 * Builds a real editor on a minimal theme stub (`render()` is never called, so
 * only `borderColor` is read), captures every
 * host callback into {@link HostEffects}, and drives it through the keystroke
 * DSL. Buffer state is seeded from and asserted against cursor-marker strings
 * (see `state.ts`), so a case reads like vim.
 *
 * Convention: a freshly created editor is in INSERT mode with the cursor at the
 * seeded marker. NORMAL-mode cases therefore begin their `keys` with `<Esc>`.
 */

import type { EditorTheme } from "@oh-my-pi/pi-tui";
import { describe, expect, test } from "bun:test";
import { ModalVimEditor, type VimMode } from "../../src/modal-editor.ts";
import { keys } from "./keys.ts";
import { parseState, renderState } from "./state.ts";

// Minimal EditorTheme stub. Tests never call render(), so only borderColor is
// read (stored by the base Editor constructor). Cast once, at this seam.
const theme = { borderColor: (s: string) => s } as unknown as EditorTheme;

/** Every host-facing effect the editor can emit, captured in order. */
export interface HostEffects {
	/** `onModeChange` log. */
	modes: VimMode[];
	/** `onExCommandChange` log (`":q"` … or `null` when ex closes). */
	exCommands: (string | null)[];
	/** Command lines dispatched via `runExCommand` (`/name args`, `!cmd`, `/quit`). */
	dispatched: string[];
	/** `notifyUser` warnings. */
	notifications: string[];
	/** `onSubmit` payloads (the fallback dispatch path, when `runExCommand` is unwired). */
	submitted: string[];
}

export interface CreateHarnessOptions {
	/** Names `getCommandNames` resolves to (known slash commands for `:name`). */
	commandNames?: string[];
	/** Wire `runExCommand` (default true). Set false to exercise the setText+onSubmit fallback. */
	wireRunExCommand?: boolean;
}

export interface Harness {
	ed: ModalVimEditor;
	fx: HostEffects;
	/** Expand `notation` and feed each chunk to `handleInput`. */
	send(notation: string): void;
	/** Replace the buffer and place the cursor per a cursor-marker string. Stays in INSERT. */
	seed(marked: string): void;
	/** Current buffer + cursor as a cursor-marker string. */
	state(): string;
}

/** Move the cursor to a seeded (line, col) using only public editor moves. */
function seedCursor(ed: ModalVimEditor, line: number, col: number): void {
	ed.moveToMessageStart();
	for (let i = 0; i < line; i++) ed.handleDraftEdit("\x1b[B"); // down
	ed.moveToLineStart();
	for (let i = 0; i < col; i++) ed.handleDraftEdit("\x1b[C"); // right (one grapheme)
}

/** Build a headless editor with a theme stub and all host callbacks captured. */
export function createHarness(opts: CreateHarnessOptions = {}): Harness {
	const ed = new ModalVimEditor(theme);
	const fx: HostEffects = { modes: [], exCommands: [], dispatched: [], notifications: [], submitted: [] };
	ed.onModeChange = (m) => fx.modes.push(m);
	ed.onExCommandChange = (c) => fx.exCommands.push(c);
	ed.notifyUser = (m) => fx.notifications.push(m);
	ed.getCommandNames = () => new Set(opts.commandNames ?? []);
	ed.onSubmit = (t) => {
		fx.submitted.push(t);
	};
	if (opts.wireRunExCommand !== false) {
		ed.runExCommand = (line) => {
			fx.dispatched.push(line);
		};
	}
	return {
		ed,
		fx,
		send(notation) {
			for (const chunk of keys(notation)) ed.handleInput(chunk);
		},
		seed(marked) {
			const { text, line, col } = parseState(marked);
			ed.setText(text);
			seedCursor(ed, line, col);
		},
		state() {
			const { line, col } = ed.getCursor();
			return renderState({ text: ed.getText(), line, col });
		},
	};
}

/** One table-driven editor case: seed `before`, send `keys`, assert `after`. */
export interface VimCase {
	/** Cursor-marker start state (editor is in INSERT at the marker). */
	before: string;
	/** Keystroke-DSL notation (NORMAL-mode cases start with `<Esc>`). */
	keys: string;
	/** Expected cursor-marker end state. */
	after: string;
	/** Optional: assert the final vim mode. */
	mode?: VimMode;
	/** Optional: override the auto-generated test name. */
	name?: string;
	/** Optional: seed known slash-command names (for `:name` dispatch cases). */
	commandNames?: string[];
}

function caseName(c: VimCase): string {
	return c.name ?? `${JSON.stringify(c.before)} ${c.keys} -> ${JSON.stringify(c.after)}`;
}

/** Run a single case's assertions against a fresh harness. */
export function runCase(c: VimCase): void {
	const h = createHarness({ commandNames: c.commandNames });
	h.seed(c.before);
	h.send(c.keys);
	expect(h.state()).toBe(c.after);
	if (c.mode !== undefined) expect(h.ed.mode).toBe(c.mode);
}

/**
 * Register editor cases as `bun test` cases. `vt(c)` is one `test`; `vt.each([…])`
 * is one `test` per row. Call inside a `describe`.
 */
export const vt: ((c: VimCase) => void) & { each: (cases: VimCase[]) => void } = Object.assign(
	(c: VimCase) => {
		test(caseName(c), () => runCase(c));
	},
	{
		each(cases: VimCase[]) {
			for (const c of cases) test(caseName(c), () => runCase(c));
		},
	},
);

export { describe, expect, test };

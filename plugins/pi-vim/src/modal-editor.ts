import { CustomEditor } from "@oh-my-pi/pi-coding-agent";
import { matchesKey } from "@oh-my-pi/pi-tui";
import { graphemeCount, graphemeSteps, lineColToAbs, moveCursorToAbs } from "./host/keystroke-bridge.js";
import type { HostEffects, Pos, AbsRange, VimMode } from "./host/adapter.js";
export type { VimMode } from "./host/adapter.js";
import { History, type Snapshot } from "./host/history.js";
import { parseExLine } from "./ex/parser.js";
import { dispatchEx, type ExHost } from "./ex/commands.js";
import { type VimState, makeVimState, resetInput, takeCount, hasPending } from "./engine/state.js";
import { evaluate } from "./engine/dispatch.js";

/**
 * Raw terminal byte sequences replayed into the base editor. NORMAL-mode
 * commands never poke the base `Editor`'s hard-private `#state`; they compute a
 * target with the vendored pure functions and then walk the cursor there with
 * these keys, so the base editor keeps ownership of grapheme boundaries, line
 * wrapping, undo, and autocomplete dismissal.
 */
const SEQ = {
	left: "\x1b[D",
	right: "\x1b[C",
	up: "\x1b[A",
	down: "\x1b[B",
	deleteForward: "\x1b[3~", // forward delete
} as const;

/**
 * A {@link CustomEditor} that adds Vim NORMAL/INSERT modal editing to omp's
 * prompt.
 *
 * INSERT mode is the base editor verbatim. NORMAL mode intercepts keys before
 * the buffer sees them and dispatches motions, operators (`d`/`c`), and text
 * objects. Motion targets are computed by the pure, nvim-parity functions
 * vendored under `./vim/` (offsets into the buffer text); the editor's driving
 * primitives translate those offsets into replayed key presses. Every unmapped
 * printable key is swallowed so it can never leak into the draft.
 */
export class ModalVimEditor extends CustomEditor implements HostEffects {
	/**
	 * All mutable vim state consolidated into one struct.
	 */
	#state: VimState = makeVimState();
	/** Notified on every mode change so the host can repaint the indicator + cursor shape. */
	onModeChange: ((mode: VimMode) => void) | undefined;
	/** Fired whenever the ex command buffer changes. */
	onExCommandChange: ((command: string | null) => void) | undefined;
	/** Dispatches a command line through the host. */
	runExCommand: ((commandLine: string) => void | Promise<void>) | undefined;
	/** Warning notifications. */
	notifyUser: ((message: string) => void) | undefined;
	/**
	 * Resolved at submit time so mid-session-registered commands are reachable.
	 * Non-optional with a no-op default so the class satisfies {@link HostEffects}.
	 */
	getCommandNames: () => ReadonlySet<string> = () => new Set<string>();
	/**
	 * pi-vim owns its own undo/redo timeline instead of the base editor's.
	 */
	#history = new History();

	get mode(): VimMode {
		return this.#state.mode;
	}

	/** Enter a mode and fire {@link onModeChange} when it actually changed. */
	setMode(mode: VimMode): void {
		resetInput(this.#state);
		if (this.#state.mode === mode) return;
		this.#state.mode = mode;
		this.onModeChange?.(mode);
	}

	#resetPending(): void {
		resetInput(this.#state);
	}

	/** True when a multi-key command is mid-flight. */
	#hasPending(): boolean {
		return hasPending(this.#state);
	}

	/** Resolve and consume the pending count, defaulting to 1. */
	#takeCount(): number {
		return takeCount(this.#state);
	}

	#repeat(seq: string, times: number): void {
		for (let i = 0; i < times; i++) this.handleDraftEdit(seq);
	}

	// --- undo / redo (pi-vim owns its own timeline) ------------------------

	#snapshot(): Snapshot {
		const { line, col } = this.getCursor();
		return { text: this.getText(), line, col };
	}

	#beginChange(): void {
		this.#history.begin(this.getText(), this.getCursor());
	}

	#commitChange(): void {
		this.#history.commit(this.getText());
	}

	/** Restore the buffer to `snap` (text + cursor) via the base editor's public API. */
	#restore(snap: Snapshot): void {
		this.setText(snap.text);
		this.#moveToAbs(lineColToAbs(this.getLines(), snap.line, snap.col));
	}

	/** `u`: revert the last committed change. */
	#undo(count: number): void {
		this.#history.cancelPending();
		for (let i = 0; i < count; i++) {
			const prev = this.#history.undo(this.#snapshot());
			if (prev === null) return;
			this.#restore(prev);
		}
	}

	/** `Ctrl+r`: reapply the last undone change. */
	#redo(count: number): void {
		this.#history.cancelPending();
		for (let i = 0; i < count; i++) {
			const next = this.#history.redo(this.#snapshot());
			if (next === null) return;
			this.#restore(next);
		}
	}

	// --- driving primitives (offset -> key replay) -------------------------

	/**
	 * Move the cursor to an absolute buffer offset. Delegates the anchor +
	 * line-then-column replay loop to {@link moveCursorToAbs} in
	 * `src/host/keystroke-bridge.ts`.
	 */
	#moveToAbs(abs: number): void {
		moveCursorToAbs(this, abs, {
			moveToMessageStart: () => this.moveToMessageStart(),
			moveToLineStart: () => this.moveToLineStart(),
			replay: (seq, n) => this.#repeat(seq, n),
		});
	}

	/**
	 * Delete the half-open buffer range `[lo, hi)` by replaying forward-delete
	 * keys from `lo`. Used internally by `replaceRange`.
	 */
	#deleteAbsRange(lo: number, hi: number): void {
		if (hi <= lo) return;
		// Deletes fill the unnamed register (charwise). Linewise callers overwrite.
		this.#yankToRegister(this.getText().slice(lo, hi), false);
		const n = graphemeCount(this.getText().slice(lo, hi));
		this.#moveToAbs(lo);
		this.#repeat(SEQ.deleteForward, n);
	}

	/** Store `text` in the unnamed register, tagging it charwise or linewise. */
	#yankToRegister(text: string, linewise: boolean): void {
		this.#state.registers.set({ text, linewise });
	}

	// --- input handling ----------------------------------------------------

	override handleInput(data: string): void {
		if (this.#state.mode === "insert") {
			// In INSERT mode, Escape is the one key we own: it drops to NORMAL
			// instead of firing the app interrupt. Everything else is the base
			// editor unchanged (typing, paste, history, autocomplete, submit).
			if (this.#isEscape(data)) {
				this.setMode("normal");
				// Vim rests the NORMAL cursor ON a character, not past the last
				// one, so leaving INSERT steps left one grapheme (unless already
				// at column 0). This keeps `x`, `$`, and backward finds aligned.
				if (this.getCursor().col > 0) this.handleDraftEdit(SEQ.left);
				return;
			}
			// One undo unit per INSERT keystroke.
			this.#beginChange();
			super.handleInput(data);
			this.#commitChange();
			return;
		}
		// EX mode: route to the ex buffer handler (never opens an undo unit).
		if (this.#state.exBuffer !== null) {
			this.#handleEx(data);
			return;
		}
		// NORMAL / VISUAL command: snapshot the buffer, dispatch via the
		// table-driven evaluator, then commit the change.
		this.#beginChange();
		evaluate({ state: this.#state, host: this }, data);
		this.#commitChange();
	}

	#isEscape(data: string): boolean {
		return matchesKey(data, "escape") || data === "\x1b" || matchesKey(data, "ctrl+[");
	}

	// --- ex mode -----------------------------------------------------------

	/** Open the ex command buffer. */
	#startEx(): void {
		this.#state.exBuffer = ":";
		this.onExCommandChange?.(":");
	}

	/** Close the ex command buffer without submitting. */
	#clearEx(): void {
		this.#state.exBuffer = null;
		this.onExCommandChange?.(null);
	}

	/** Update the ex command buffer and notify the host. */
	#setEx(next: string): void {
		this.#state.exBuffer = next;
		this.onExCommandChange?.(next);
	}

	/**
	 * Route a keystroke while ex mode is active.
	 */
	#handleEx(data: string): void {
		if (this.#isEscape(data)) {
			this.#clearEx();
			return;
		}
		if (matchesKey(data, "enter") || data === "\r" || data === "\n") {
			this.#submitEx();
			return;
		}
		if (matchesKey(data, "backspace") || data === "\x7f" || data === "\x08") {
			if (this.#state.exBuffer === ":") {
				this.#clearEx();
			} else {
				this.#setEx((this.#state.exBuffer ?? "").slice(0, -1));
			}
			return;
		}
		// Bracketed paste: extract first line, never auto-submit on embedded newline.
		if (data.includes("\x1b[200~")) {
			const startIdx = data.indexOf("\x1b[200~") + 6;
			const endMarker = data.indexOf("\x1b[201~");
			const raw = endMarker === -1 ? data.slice(startIdx) : data.slice(startIdx, endMarker);
			const nlIdx = raw.search(/[\r\n]/);
			const firstLine = nlIdx === -1 ? raw : raw.slice(0, nlIdx);
			this.#setEx((this.#state.exBuffer ?? "") + firstLine);
			return;
		}
		// Non-printable control chunk not handled above: bail out of ex mode.
		if (data.length > 0 && data.charCodeAt(0) < 0x20) {
			this.#clearEx();
			return;
		}
		this.#setEx((this.#state.exBuffer ?? "") + data);
	}

	/**
	 * Submit the current ex command buffer.
	 */
	#submitEx(): void {
		const raw = (this.#state.exBuffer ?? "").slice(1); // strip leading ":"
		this.#clearEx();
		const parse = parseExLine(raw);
		if (parse.kind === "empty") return;

		const host: ExHost = {
			runExCommand: (commandLine) => {
				this.#runExWithRestore(commandLine);
			},
			notifyUser: (msg) => { this.notifyUser?.(msg); },
			getCommandNames: () => this.getCommandNames?.() ?? new Set<string>(),
			getText: () => this.getText(),
			dispatchQuit: () => {
				this.setText("");
				this.#dispatchQuit();
			},
		};

		dispatchEx(parse, host);
	}

	/**
	 * Run `commandLine` through the host, then synchronously restore the
	 * draft buffer + cursor.
	 */
	#runExWithRestore(commandLine: string): void {
		const text = this.getText();
		const { line, col } = this.getCursor();

		let r: void | Promise<void>;
		if (this.runExCommand !== undefined) {
			r = this.runExCommand(commandLine);
		} else {
			this.setText(commandLine);
			r = this.onSubmit?.(commandLine);
		}

		this.setText(text);
		this.#moveToAbs(lineColToAbs(this.getLines(), line, col));

		if (r instanceof Promise) {
			void r
				.then(() => {
					if (this.getText() === "") {
						this.setText(text);
						this.#moveToAbs(lineColToAbs(this.getLines(), line, col));
					}
				})
				.catch(() => {
					// Swallow: a throw must not break the editor.
				});
		}
	}

	#dispatchQuit(): void {
		if (this.runExCommand !== undefined) {
			void this.runExCommand("/quit");
			return;
		}
		this.setText("/quit");
		void this.onSubmit?.("/quit");
	}

	// --- HostEffects facade -------------------------------------------------

	/** Move the cursor to a buffer position by replaying arrow keys. */
	moveCursor(to: Pos): void {
		this.#moveToAbs(lineColToAbs(this.getLines(), to.line, to.col));
	}

	/**
	 * Replace the UTF-16 half-open range `[range.start, range.end)` with `text`.
	 */
	replaceRange(range: AbsRange, text: string): void {
		if (range.start < range.end) {
			this.#deleteAbsRange(range.start, range.end);
		} else {
			this.#moveToAbs(range.start);
		}
		if (text.length > 0) this.insertText(text);
	}

	/** Forward `data` directly to the base editor (INSERT passthrough). */
	forward(data: string): void {
		super.handleInput(data);
	}

	/** Set the active mode and fire `onModeChange` if it actually changed. */
	signalMode(mode: VimMode): void {
		this.setMode(mode);
	}

	/** Update the ex command buffer and fire `onExCommandChange`. */
	signalEx(buffer: string | null): void {
		this.#state.exBuffer = buffer;
		this.onExCommandChange?.(buffer);
	}

	/** Run `line` through the host's ex-command pipeline with buffer restore. */
	runEx(line: string): void | Promise<void> {
		this.#runExWithRestore(line);
	}

	/** Emit a warning notification via `notifyUser`. */
	notify(message: string): void {
		this.notifyUser?.(message);
	}

	/** Undo the last committed change(s). Cancels the open pending change. */
	undo(count: number): void {
		this.#undo(count);
	}

	/** Redo the last undone change(s). Cancels the open pending change. */
	redo(count: number): void {
		this.#redo(count);
	}
}

import { CustomEditor } from "@oh-my-pi/pi-coding-agent";
import { canonicalKeyId, matchesKey, parseKey } from "@oh-my-pi/pi-tui";

export type VimMode = "normal" | "insert";

/**
 * Raw terminal byte sequences for the keys we synthesize back into the base
 * editor. NORMAL-mode motions do not reimplement cursor math; they replay these
 * bytes through {@link CustomEditor.handleDraftEdit}, so the base `Editor`
 * keeps ownership of grapheme boundaries, line wrapping, undo, and autocomplete
 * dismissal. Legacy CSI forms are what an xterm-class terminal emits and what
 * `parseKey` canonicalizes; using them avoids depending on the Kitty protocol
 * being active.
 */
const SEQ = {
	left: "\x1b[D",
	right: "\x1b[C",
	up: "\x1b[A",
	down: "\x1b[B",
	wordLeft: "\x1b[1;3D", // alt+left
	wordRight: "\x1b[1;3C", // alt+right
	lineStart: "\x01", // ctrl+a
	lineEnd: "\x05", // ctrl+e
	deleteForward: "\x1b[3~", // forward delete (x)
	deleteWordForward: "\x1b[3;3~", // alt+delete (dw)
	deleteToLineEnd: "\x0b", // ctrl+k (D / d$)
} as const;

/**
 * A {@link CustomEditor} that adds Vim NORMAL/INSERT modal editing to omp's
 * prompt. The design intentionally stays on the base editor's *public* surface:
 * omp's `Editor` keeps its buffer in a hard-private `#state` field, so cursor
 * position is driven by replaying the editor's own key sequences rather than by
 * mutating internal state (the technique upstream `pi-vim` relies on and which
 * is unavailable here).
 *
 * INSERT mode is the base editor verbatim. NORMAL mode intercepts keys before
 * the buffer sees them: motions and edits are translated into base-editor
 * operations, and every unmapped printable key is swallowed so it can never
 * leak into the draft.
 */
export class ModalVimEditor extends CustomEditor {
	#mode: VimMode = "insert";
	/** Pending count prefix accumulated in NORMAL mode (e.g. the `12` of `12j`). */
	#count = "";
	/** True after `d` is pressed, waiting for the motion that completes the operator. */
	#pendingDelete = false;
	/** True after `g` is pressed, waiting for a second `g` (`gg`). */
	#pendingG = false;
	/** Notified on every mode change so the host can repaint the indicator + cursor shape. */
	onModeChange: ((mode: VimMode) => void) | undefined;

	get mode(): VimMode {
		return this.#mode;
	}

	/** Enter a mode and fire {@link onModeChange} when it actually changed. */
	setMode(mode: VimMode): void {
		this.#resetPending();
		if (this.#mode === mode) return;
		this.#mode = mode;
		this.onModeChange?.(mode);
	}

	#resetPending(): void {
		this.#count = "";
		this.#pendingDelete = false;
		this.#pendingG = false;
	}

	/** Resolve and consume the pending count, defaulting to 1. Clamped to a sane ceiling. */
	#takeCount(): number {
		const n = this.#count === "" ? 1 : Number.parseInt(this.#count, 10);
		this.#count = "";
		return Math.min(Math.max(n, 1), 9999);
	}

	#repeat(seq: string, times: number): void {
		for (let i = 0; i < times; i++) this.handleDraftEdit(seq);
	}

	override handleInput(data: string): void {
		if (this.#mode === "insert") {
			// In INSERT mode, Escape is the one key we own: it drops to NORMAL
			// instead of firing the app interrupt. Everything else is the base
			// editor unchanged (typing, paste, history, autocomplete, submit).
			if (this.#isEscape(data)) {
				this.setMode("normal");
				return;
			}
			super.handleInput(data);
			return;
		}
		this.#handleNormal(data);
	}

	#isEscape(data: string): boolean {
		return matchesKey(data, "escape") || data === "\x1b" || matchesKey(data, "ctrl+[");
	}

	/**
	 * NORMAL-mode dispatch. Returns nothing; every branch either performs an
	 * editor operation or deliberately swallows the key. Unhandled printable
	 * keys are dropped so they never mutate the draft.
	 */
	#handleNormal(data: string): void {
		const parsed = parseKey(data);
		const canonical = parsed !== undefined ? canonicalKeyId(parsed) : undefined;

		if (this.#isEscape(data)) {
			this.#resetPending();
			return;
		}

		// Modified chords (ctrl+p model cycle, ctrl+r history, ctrl+g external
		// editor, …) and Enter (submit) fall through to the base handler so
		// nothing the user relies on disappears while in NORMAL mode. A bare
		// `shift+<letter>` is still text-like, so it is excluded and handled by
		// the motion table below.
		const isAppChord =
			canonical !== undefined && canonical.includes("+") && !canonical.startsWith("shift+");
		if (canonical === "enter" || data === "\r" || data === "\n" || isAppChord) {
			super.handleInput(data);
			return;
		}

		// Digits build a count prefix (but a leading 0 is the "line start" motion).
		if (/^[1-9]$/.test(data) || (data === "0" && this.#count !== "")) {
			this.#count += data;
			return;
		}

		// Operator-pending: `d` was pressed, this key is its motion.
		if (this.#pendingDelete) {
			this.#applyDeleteMotion(data);
			return;
		}

		// `g` prefix: only `gg` is defined.
		if (this.#pendingG) {
			this.#pendingG = false;
			if (data === "g") {
				this.moveToMessageStart();
			}
			this.#count = "";
			return;
		}

		switch (data) {
			// --- mode switches into INSERT ---
			case "i":
				this.setMode("insert");
				return;
			case "a":
				this.handleDraftEdit(SEQ.right);
				this.setMode("insert");
				return;
			case "I":
				this.moveToLineStart();
				this.setMode("insert");
				return;
			case "A":
				this.moveToLineEnd();
				this.setMode("insert");
				return;
			case "o":
				this.moveToLineEnd();
				this.setMode("insert");
				this.insertText("\n");
				return;
			case "O":
				this.moveToLineStart();
				this.insertText("\n");
				this.handleDraftEdit(SEQ.up);
				this.setMode("insert");
				return;

			// --- horizontal / vertical motions ---
			case "h":
				this.#repeat(SEQ.left, this.#takeCount());
				return;
			case "l":
				this.#repeat(SEQ.right, this.#takeCount());
				return;
			case "j":
				this.#repeat(SEQ.down, this.#takeCount());
				return;
			case "k":
				this.#repeat(SEQ.up, this.#takeCount());
				return;
			case "w":
				this.#repeat(SEQ.wordRight, this.#takeCount());
				return;
			case "b":
				this.#repeat(SEQ.wordLeft, this.#takeCount());
				return;
			case "0":
				this.moveToLineStart();
				return;
			case "$":
				this.moveToLineEnd();
				return;
			case "G":
				// `{count}G` → absolute line is out of scope without cursor writes;
				// bare G jumps to end of buffer, matching the common case.
				this.#count = "";
				this.moveToMessageEnd();
				return;
			case "g":
				this.#pendingG = true;
				return;

			// --- edits ---
			case "x":
				this.#repeat(SEQ.deleteForward, this.#takeCount());
				return;
			case "D":
				this.handleDraftEdit(SEQ.deleteToLineEnd);
				return;
			case "d":
				this.#pendingDelete = true;
				return;

			default:
				// Swallow every other key: NORMAL mode must never leak text.
				return;
		}
	}

	#applyDeleteMotion(data: string): void {
		this.#pendingDelete = false;
		const count = this.#takeCount();
		switch (data) {
			case "d": // dd → clear the whole current line's text to its start+end
				this.moveToLineStart();
				this.handleDraftEdit(SEQ.deleteToLineEnd);
				return;
			case "w":
				for (let i = 0; i < count; i++) this.#deleteWordForwardVim();
				return;
			case "$":
				this.handleDraftEdit(SEQ.deleteToLineEnd);
				return;
			case "l":
				this.#repeat(SEQ.deleteForward, count);
				return;
			default:
				// Unknown motion cancels the operator, vim-style.
				return;
		}
	}

	/**
	 * Vim `dw`: delete from the cursor to the start of the next word, including
	 * the run of whitespace after it. omp's base word-forward delete
	 * (`deleteWordForward`) is emacs-style — it stops at the end of the word and
	 * leaves the following space — so after replaying it we consume any spaces
	 * now under the cursor via forward-delete. Both steps go through the base
	 * editor, so undo and grapheme handling stay correct.
	 */
	#deleteWordForwardVim(): void {
		this.handleDraftEdit(SEQ.deleteWordForward);
		let line = this.getLines()[this.getCursor().line] ?? "";
		let col = this.getCursor().col;
		while (col < line.length && (line[col] === " " || line[col] === "\t")) {
			this.handleDraftEdit(SEQ.deleteForward);
			line = this.getLines()[this.getCursor().line] ?? "";
			col = this.getCursor().col;
		}
	}
}

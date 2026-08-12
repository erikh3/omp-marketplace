import { CustomEditor } from "@oh-my-pi/pi-coding-agent";
import { canonicalKeyId, matchesKey, parseKey } from "@oh-my-pi/pi-tui";
import { absToLineCol, graphemeCount, graphemeSteps, lineColToAbs } from "./vim/bridge.js";
import {
	findCharMotionTarget,
	findFirstNonWhitespaceColumn,
	findParagraphMotionTarget,
	findWordMotionTarget,
	getLineGraphemes,
	isBlankLine,
	reverseCharMotion,
	type WordMotionClass,
} from "./vim/motions.js";
import {
	resolveDelimitedTextObjectRange,
	resolveMatchingPairMotionTarget,
	resolveWordTextObjectRange,
	type TextObjectKind,
} from "./vim/text-objects.js";
import type { CharMotion } from "./vim/types.js";
import {
	getVisualLineRange,
	getInclusiveEndColumn,
	orderVisualEndpoints,
	clampVisualPosition,
	type VisualPosition,
} from "./vim/visual.js";

export type VimMode = "normal" | "insert" | "visual" | "visual-line";

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

/** Any single grapheme is at most a handful of UTF-16 units; this window is a
 * safe upper bound for measuring the cluster that starts at an offset. */
const GRAPHEME_WINDOW = 16;

type Operator = "d" | "c" | "y";

/** One point on pi-vim's own undo/redo timeline: the full buffer text plus the
 * cursor to restore it to. */
type EditSnapshot = { text: string; line: number; col: number };

/** Cap on each history stack so a long session can't grow it without bound. */
const MAX_HISTORY = 500;

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
export class ModalVimEditor extends CustomEditor {
	#mode: VimMode = "insert";
	/** Pending count prefix accumulated in NORMAL mode (e.g. the `12` of `12j`). */
	#count = "";
	/** Set after `d`/`c`; the next key(s) resolve the operator's range. */
	#op: Operator | null = null;
	/** Set after an operator sees `i`/`a`; the next key is the text-object. */
	#textObject: TextObjectKind | null = null;
	/** Set after `f`/`F`/`t`/`T` (bare or under an operator); next key is the target char. */
	#charPending: CharMotion | null = null;
	/** Set after `r`; next key replaces the grapheme under the cursor. */
	#replacePending = false;
	/** True after `g`, waiting for a second `g` (`gg`). */
	#pendingG = false;
	/** Last `f`/`F`/`t`/`T` for `;` / `,` repeat. */
	#lastCharMotion: { motion: CharMotion; char: string } | null = null;
	/** Where `v`/`V` was pressed; the fixed end of the live visual selection. */
	#visualAnchor: VisualPosition | null = null;
	/**
	 * Vim's unnamed register: the last yanked/deleted/changed text plus whether
	 * it was captured linewise. `p`/`P` read it; a linewise payload pastes on its
	 * own line(s), a charwise one inline. `null` means nothing has been captured.
	 */
	#register: { text: string; linewise: boolean } | null = null;
	/** Notified on every mode change so the host can repaint the indicator + cursor shape. */
	onModeChange: ((mode: VimMode) => void) | undefined;
	/** Fired whenever the ex command buffer changes: the full buffer starting with ":"
	 * (e.g. `":q"`) while ex mode is active, or `null` when ex mode is inactive/cleared. */
	onExCommandChange: ((command: string | null) => void) | undefined;
	/** Dispatches a command line (`"/name args"` or `"!cmd"`) through the host. Optional;
	 * when unset, the editor falls back to setting the buffer text and calling {@link onSubmit}. */
	runExCommand: ((commandLine: string) => void | Promise<void>) | undefined;
	/** Host shutdown (`:q` etc.). Optional; unset = no-op. */
	onQuit: (() => void) | undefined;
	/** Warning notifications ("Unsupported ex command", quit-with-dirty-prompt, etc.). */
	notifyUser: ((message: string) => void) | undefined;
	/** Resolved at submit time so mid-session-registered commands are reachable. */
	getCommandNames: (() => ReadonlySet<string>) | undefined;
	/**
	 * pi-vim owns its own undo/redo timeline instead of the base editor's, whose
	 * `#applyUndo` pops without capturing the replaced state (so it cannot redo)
	 * and which snapshots once per delete *call* (so a multi-key edit undoes one
	 * grapheme at a time). We snapshot the whole buffer before each change and
	 * restore via `setText`, so one `u` / `Ctrl+r` moves one whole vim command
	 * regardless of how many base operations the change ran.
	 */
	#undoStack: EditSnapshot[] = [];
	#redoStack: EditSnapshot[] = [];
	/** Snapshot taken when the current change began, pending commit once it ends. */
	#pendingSnapshot: EditSnapshot | null = null;
	/** `null` when ex mode is inactive; otherwise the full command buffer starting with `":"`. */
	#exCommand: string | null = null;

	/** Quit command names recognised by `:q` / `:qa` / `:quit` etc. */
	static readonly #QUIT_NAMES: Record<string, true> = {
		q: true, qa: true, quit: true, qall: true, quitall: true,
	};
	/** Ex commands reserved for future line-address / range support; notify instead of dispatch. */
	static readonly #RESERVED_NAMES: Record<string, true> = {
		s: true, g: true, v: true, d: true, m: true, t: true, co: true, j: true,
		w: true, r: true, normal: true, sort: true, "&": true, ">": true, "<": true,
	};

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
		this.#op = null;
		this.#textObject = null;
		this.#charPending = null;
		this.#replacePending = false;
		this.#pendingG = false;
	}

	/** True when a multi-key command is mid-flight (count/operator/find/etc.). */
	#hasPending(): boolean {
		return (
			this.#count !== "" ||
			this.#op !== null ||
			this.#textObject !== null ||
			this.#charPending !== null ||
			this.#replacePending ||
			this.#pendingG
		);
	}

	/** Resolve and consume the pending count, defaulting to 1. Clamped to a sane ceiling. */
	#takeCount(): number {
		const n = this.#count === "" ? 1 : Number.parseInt(this.#count, 10);
		this.#count = "";
		return Math.min(Math.max(Number.isFinite(n) ? n : 1, 1), 9999);
	}

	#repeat(seq: string, times: number): void {
		for (let i = 0; i < times; i++) this.handleDraftEdit(seq);
	}

	// --- undo / redo (pi-vim owns its own timeline) ------------------------

	#snapshot(): EditSnapshot {
		const { line, col } = this.getCursor();
		return { text: this.getText(), line, col };
	}

	/**
	 * Mark the start of a change: record the pre-edit buffer so a later
	 * {@link #commitChange} can push it onto the undo stack. No-op if a change is
	 * already open, so an insert session (many keystrokes) collapses to one unit.
	 */
	#beginChange(): void {
		if (this.#pendingSnapshot === null) this.#pendingSnapshot = this.#snapshot();
	}

	/**
	 * Close the change opened by {@link #beginChange}. Pushes the pre-edit
	 * snapshot onto the undo stack (clearing the redo stack, as any new edit
	 * does in vim) only when the buffer text actually changed, so pure motions
	 * and no-op edits leave the timeline untouched.
	 */
	#commitChange(): void {
		const before = this.#pendingSnapshot;
		this.#pendingSnapshot = null;
		if (before === null || before.text === this.getText()) return;
		this.#undoStack.push(before);
		if (this.#undoStack.length > MAX_HISTORY) this.#undoStack.shift();
		this.#redoStack.length = 0;
	}

	/** Restore the buffer to `snap` (text + cursor) via the base editor's public API. */
	#restore(snap: EditSnapshot): void {
		this.setText(snap.text);
		this.#moveToAbs(lineColToAbs(this.getLines(), snap.line, snap.col));
	}

	/** `u`: revert the last committed change and stash the current state for redo. */
	#undo(count: number): void {
		// This command drives the stacks directly; drop the snapshot the dispatch
		// wrapper opened so the trailing #commitChange is a no-op.
		this.#pendingSnapshot = null;
		for (let i = 0; i < count; i++) {
			const prev = this.#undoStack.pop();
			if (prev === undefined) return;
			this.#redoStack.push(this.#snapshot());
			this.#restore(prev);
		}
	}

	/** `Ctrl+r`: reapply the last undone change. */
	#redo(count: number): void {
		this.#pendingSnapshot = null;
		for (let i = 0; i < count; i++) {
			const next = this.#redoStack.pop();
			if (next === undefined) return;
			this.#undoStack.push(this.#snapshot());
			this.#restore(next);
		}
	}

	// --- driving primitives (offset -> key replay) -------------------------

	#curAbs(): number {
		const { line, col } = this.getCursor();
		return lineColToAbs(this.getLines(), line, col);
	}

	/** UTF-16 length of the grapheme cluster starting at `abs` in `text` (>=1). */
	#graphemeLenAt(text: string, abs: number): number {
		const first = getLineGraphemes(text.slice(abs, abs + GRAPHEME_WINDOW))[0];
		return first ? first.end - first.start : 1;
	}

	/** Move the cursor to a column of the *current* line by replaying arrows. */
	#moveToColInLine(targetCol: number): void {
		const { line, col } = this.getCursor();
		const text = this.getLines()[line] ?? "";
		const steps = graphemeSteps(text, col, targetCol);
		this.#repeat(targetCol >= col ? SEQ.right : SEQ.left, steps);
	}

	/**
	 * Move the cursor to an absolute buffer offset. Anchors at the buffer start
	 * and walks down to the target logical line (watching `getCursor().line`, so
	 * it is correct under line wrapping and never presses `down` on the last
	 * visual line where the base editor would navigate history), then walks
	 * right to the target column.
	 */
	#moveToAbs(abs: number): void {
		const { line, col } = absToLineCol(this.getLines(), abs);
		this.moveToMessageStart();
		let guard = 0;
		while (this.getCursor().line < line && guard++ < 100000) {
			const before = this.getCursor();
			this.handleDraftEdit(SEQ.down);
			const after = this.getCursor();
			if (after.line === before.line && after.col === before.col) break;
		}
		this.moveToLineStart();
		this.#moveToColInLine(col);
	}

	/**
	 * Delete the half-open buffer range `[lo, hi)` by replaying forward-delete
	 * keys from `lo`. Undo granularity is not a concern here: every edit runs
	 * inside a {@link #beginChange}/{@link #commitChange} pair, so the whole
	 * command is one entry on pi-vim's own undo timeline no matter how many base
	 * deletes it issues. `lo`/`hi` are grapheme-aligned offsets.
	 */
	#deleteAbsRange(lo: number, hi: number): void {
		if (hi <= lo) return;
		// Deletes fill the unnamed register (vim: `d`/`c`/`x`/`s` all yank what
		// they remove). Charwise here; linewise callers overwrite via
		// #yankToRegister after the delete. Paste never routes through here.
		this.#yankToRegister(this.getText().slice(lo, hi), false);
		const n = graphemeCount(this.getText().slice(lo, hi));
		this.#moveToAbs(lo);
		this.#repeat(SEQ.deleteForward, n);
	}

	/** Store `text` in the unnamed register, tagging it charwise or linewise. */
	#yankToRegister(text: string, linewise: boolean): void {
		this.#register = { text, linewise };
	}

	/**
	 * Apply a charwise motion target: with a pending operator, delete the span
	 * between the cursor and the target (inclusive of the target grapheme when
	 * `inclusive`); otherwise just move the cursor there.
	 */
	#applyCharwiseTarget(targetAbs: number, inclusive: boolean): void {
		if (this.#op === null) {
			this.#moveToAbs(targetAbs);
			return;
		}
		const cur = this.#curAbs();
		let lo = Math.min(cur, targetAbs);
		let hi = Math.max(cur, targetAbs);
		if (inclusive) hi += this.#graphemeLenAt(this.getText(), hi);
		const op = this.#op;
		if (op === "y") {
			// Yank captures charwise and leaves the cursor at the range start
			// (vim), without touching the buffer.
			this.#yankToRegister(this.getText().slice(lo, hi), false);
			this.#moveToAbs(lo);
			this.#resetPending();
			return;
		}
		this.#deleteAbsRange(lo, hi);
		if (op === "c") this.setMode("insert");
		else this.#resetPending();
	}

	/** Delete whole lines `[startLine, endLine]` (linewise), newline-correct at BOF/EOF. */
	#deleteLineRange(startLine: number, endLine: number): void {
		const lines = this.getLines();
		const last = lines.length - 1;
		const s = Math.max(0, Math.min(startLine, last));
		const e = Math.max(s, Math.min(endLine, last));
		let lo: number;
		let hi: number;
		if (e < last) {
			// A line below survives: take this line's text and its trailing "\n".
			lo = lineColToAbs(lines, s, 0);
			hi = lineColToAbs(lines, e + 1, 0);
		} else if (s > 0) {
			// Deleting through the last line: also take the preceding "\n".
			lo = lineColToAbs(lines, s - 1, (lines[s - 1] ?? "").length);
			hi = lineColToAbs(lines, e, (lines[e] ?? "").length);
		} else {
			// Whole buffer.
			lo = 0;
			hi = lineColToAbs(lines, e, (lines[e] ?? "").length);
		}
		// Capture the payload from the intact lines, but write the register only
		// AFTER the delete: #deleteAbsRange makes its own charwise capture, so
		// writing first would be clobbered. `p` then pastes it on its own line(s).
		const payload = `${lines.slice(s, e + 1).join("\n")}\n`;
		this.#deleteAbsRange(lo, hi);
		this.#yankToRegister(payload, true);
	}

	/**
	 * Vim `cc`/`{count}cc`/`cj`: collapse lines `[startLine, endLine]` into a
	 * single empty line and enter INSERT. Unlike `dd`, the line itself survives
	 * — only its text (and the newlines joining the range) is removed — so we
	 * delete charwise from the top line's start to the bottom line's text end.
	 */
	#changeLineRange(startLine: number, endLine: number): void {
		const lines = this.getLines();
		const last = lines.length - 1;
		const s = Math.max(0, Math.min(startLine, last));
		const e = Math.max(s, Math.min(endLine, last));
		const lo = lineColToAbs(lines, s, 0);
		const hi = lineColToAbs(lines, e, (lines[e] ?? "").length);
		// `cc`/`cj` capture the changed lines linewise. Write the register after
		// the delete so #deleteAbsRange's charwise capture doesn't clobber it.
		const payload = `${lines.slice(s, e + 1).join("\n")}\n`;
		this.#deleteAbsRange(lo, hi);
		this.#yankToRegister(payload, true);
		this.setMode("insert");
	}

	/**
	 * Vim `yy`/`Y`/`{count}yy`/`yj`: capture whole lines `[startLine, endLine]`
	 * linewise into the register and park the cursor at the start of the range
	 * (its first non-blank), without touching the buffer.
	 */
	#yankLineRange(startLine: number, endLine: number): void {
		const lines = this.getLines();
		const last = lines.length - 1;
		const s = Math.max(0, Math.min(startLine, last));
		const e = Math.max(s, Math.min(endLine, last));
		this.#yankToRegister(`${lines.slice(s, e + 1).join("\n")}\n`, true);
		// Park at the first non-blank of the range start. Move directly (not via
		// #gotoLine, which is operator-aware and would re-enter this yank while
		// #op is still "y").
		const text = lines[s] ?? "";
		const col = isBlankLine(text) ? 0 : findFirstNonWhitespaceColumn(text);
		this.#moveToAbs(lineColToAbs(lines, s, col));
	}

	/**
	 * Dispatch a linewise operator (`d`/`c`/`y`) over lines `[top, bottom]`,
	 * resetting pending state as vim does (`d`/`y` return to NORMAL; `c` enters
	 * INSERT, handled by {@link #changeLineRange}). Shared by `dd`/`cc`/`yy`,
	 * `dj`/`ck`/`yj`, and `dgg`/`dG`.
	 */
	#applyLinewiseOperator(op: Operator, top: number, bottom: number): void {
		if (op === "d") {
			this.#deleteLineRange(top, bottom);
			this.#resetPending();
		} else if (op === "c") {
			this.#changeLineRange(top, bottom);
		} else {
			this.#yankLineRange(top, bottom);
			this.#resetPending();
		}
	}

	/**
	 * Vim `p`/`P`: paste the unnamed register `count` times. `after` selects `p`
	 * (charwise: after the cursor grapheme; linewise: on new line(s) below) vs
	 * `P` (charwise: before the cursor; linewise: line(s) above). Charwise leaves
	 * the cursor on the last pasted grapheme; linewise on the first non-blank of
	 * the first pasted line, matching vim.
	 */
	#paste(count: number, after: boolean): void {
		const reg = this.#register;
		if (reg === null || reg.text === "") return;

		if (reg.linewise) {
			const content = reg.text.endsWith("\n") ? reg.text.slice(0, -1) : reg.text;
			const block = Array.from({ length: count }, () => content).join("\n");
			const { line } = this.getCursor();
			if (after) {
				this.moveToLineEnd();
				this.insertText(`\n${block}`);
				this.#gotoLine(line + 1);
			} else {
				this.moveToLineStart();
				this.insertText(`${block}\n`);
				this.#gotoLine(line);
			}
			return;
		}

		const text = reg.text.repeat(count);
		const curAbs = this.#curAbs();
		const { line } = this.getCursor();
		const onNonEmptyLine = (this.getLines()[line] ?? "").length > 0;
		// `p` inserts after the grapheme under the cursor (unless the line is
		// empty); `P` inserts at the cursor. Vim then rests on the last pasted
		// grapheme, so step back one from the paste end.
		const insertAbs = after && onNonEmptyLine ? curAbs + this.#graphemeLenAt(this.getText(), curAbs) : curAbs;
		this.#moveToAbs(insertAbs);
		this.insertText(text);
		this.#moveToAbs(insertAbs + text.length);
		this.handleDraftEdit(SEQ.left);
	}

	// --- motion target computation (drives the pure functions) -------------

	/** Absolute offset for a `w`/`b`/`e`/`W`/`B`/`E` motion, count steps, cross-line. */
	#wordTargetAbs(
		direction: "forward" | "backward",
		target: "start" | "end",
		semanticClass: WordMotionClass,
		count: number,
	): number {
		const lines = this.getLines();
		const last = lines.length - 1;
		let { line, col } = this.getCursor();

		for (let n = 0; n < count; n++) {
			const beforeLine = line;
			const beforeCol = col;
			const cur = lines[line] ?? "";
			const t = findWordMotionTarget(cur, col, direction, target, semanticClass);

			if (direction === "forward" && target === "start") {
				// `w`: advance within the line, else jump to the first word of the next line.
				if (t > col && t < cur.length) {
					col = t;
				} else if (line < last) {
					line++;
					const nl = lines[line] ?? "";
					col = isBlankLine(nl) ? 0 : findFirstNonWhitespaceColumn(nl);
				} else {
					col = cur.length;
				}
			} else if (direction === "forward") {
				// `e`: end of next word, crossing to the next line if none remains here.
				if (t > col) {
					col = t;
				} else if (line < last) {
					line++;
					const nl = lines[line] ?? "";
					col = findWordMotionTarget(nl, 0, "forward", "end", semanticClass);
				}
			} else {
				// `b`: start of previous word, crossing to the prior line if needed.
				if (t < col) {
					col = t;
				} else if (line > 0) {
					line--;
					const pl = lines[line] ?? "";
					col = findWordMotionTarget(pl, pl.length, "backward", "start", semanticClass);
				} else {
					col = 0;
				}
			}

			if (line === beforeLine && col === beforeCol) break;
		}

		return lineColToAbs(lines, line, col);
	}

	// --- input handling ----------------------------------------------------

	override handleInput(data: string): void {
		if (this.#mode === "insert") {
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
			// One undo unit per INSERT keystroke: typing undoes character by
			// character, and a paste (assembled into a single buffer mutation by
			// the base editor) undoes as one unit. Keystrokes that change nothing
			// (arrows, no-op history keys) leave the timeline untouched because
			// #commitChange no-ops when the text is unchanged.
			this.#beginChange();
			super.handleInput(data);
			this.#commitChange();
			return;
		}
		// EX (execute) mode is a NORMAL sub-state: while a `:` command line is
		// open, every key edits that buffer, never the draft or the undo timeline
		// (routed before #beginChange so no undo unit forms).
		if (this.#exCommand !== null) {
			this.#handleEx(data);
			return;
		}
		// NORMAL command: snapshot the buffer, dispatch, then commit. Commands
		// that only switch to INSERT (`i`, `a`) change no text, so the commit
		// no-ops; commands that also edit (`o`, `cw`, `s`) commit that edit as
		// its own unit before the per-keystroke insert units that follow.
		this.#beginChange();
		this.#handleNormal(data);
		this.#commitChange();
	}

	#isEscape(data: string): boolean {
		return matchesKey(data, "escape") || data === "\x1b" || matchesKey(data, "ctrl+[");
	}

	/**
	 * NORMAL-mode dispatch. Pending sub-states (char-find, text-object,
	 * operator, `g`, `r`) are consumed before the main key table, matching
	 * vim's precedence. Every branch either performs an editor operation or
	 * deliberately swallows the key so NORMAL mode never leaks text.
	 */
	#handleNormal(data: string): void {
		const parsed = parseKey(data);
		const canonical = parsed !== undefined ? canonicalKeyId(parsed) : undefined;

		if (this.#isEscape(data)) {
			// ESC in a VISUAL mode drops the selection and returns to NORMAL
			// (swallowed — it never reaches the host interrupt).
			if (this.#mode === "visual" || this.#mode === "visual-line") {
				this.#exitVisual();
				return;
			}
			// ESC in NORMAL cancels an in-flight command (count/operator/find/…)
			// and is swallowed. With nothing pending it is a no-op for the buffer,
			// so we forward it to the host — this is what lets a second ESC (after
			// the INSERT→NORMAL one) reach omp's interrupt to stop the agent.
			if (this.#hasPending()) {
				this.#resetPending();
				return;
			}
			super.handleInput(data);
			return;
		}

		// `Ctrl+r` is vim redo — claim it before the app-chord passthrough (where
		// it would otherwise reach the host's history search).
		if (canonical === "ctrl+r") {
			this.#redo(this.#takeCount());
			this.#resetPending();
			return;
		}

		// Modified chords (ctrl+p model cycle, … ) and Enter (submit) fall through
		// to the base handler. A bare `shift+<letter>` is still text-like, so it
		// is handled by the key table below.
		const isAppChord =
			canonical !== undefined && canonical.includes("+") && !canonical.startsWith("shift+");
		if (canonical === "enter" || data === "\r" || data === "\n" || isAppChord) {
			this.#resetPending();
			super.handleInput(data);
			return;
		}

		// Digits build a count prefix (a leading 0 is the "line start" motion).
		if (/^[1-9]$/.test(data) || (data === "0" && this.#count !== "")) {
			this.#count += data;
			return;
		}

		if (this.#replacePending) {
			this.#resolveReplace(data);
			return;
		}
		if (this.#charPending !== null) {
			this.#resolveCharFind(data);
			return;
		}
		if (this.#textObject !== null) {
			this.#resolveTextObject(data);
			return;
		}
		if (this.#op !== null) {
			this.#handleOperatorKey(data);
			return;
		}
		if (this.#pendingG) {
			this.#pendingG = false;
			if (data === "g") this.#gotoLine(this.#count === "" ? 0 : this.#takeCount() - 1);
			this.#count = "";
			return;
		}

		// In visual modes, non-motion keys (operators, mode toggles, `o` swap) are
		// consumed here; motions and counts fall through to #handleNormalKey so
		// the cursor moves and thereby resizes the selection against the anchor.
		if ((this.#mode === "visual" || this.#mode === "visual-line") && this.#handleVisual(data)) {
			return;
		}

		this.#handleNormalKey(data);
	}

	/** First-key NORMAL dispatch (no pending sub-state). */
	#handleNormalKey(data: string): void {
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

			// --- enter VISUAL / VISUAL-LINE ---
			case "v":
				this.#enterVisual("visual");
				return;
			case "V":
				this.#enterVisual("visual-line");
				return;

			// --- simple motions (key replay is already grapheme-correct) ---
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

			// --- word motions ---
			case "w":
				this.#applyCharwiseTarget(this.#wordTargetAbs("forward", "start", "word", this.#takeCount()), false);
				return;
			case "W":
				this.#applyCharwiseTarget(this.#wordTargetAbs("forward", "start", "WORD", this.#takeCount()), false);
				return;
			case "b":
				this.#applyCharwiseTarget(this.#wordTargetAbs("backward", "start", "word", this.#takeCount()), false);
				return;
			case "B":
				this.#applyCharwiseTarget(this.#wordTargetAbs("backward", "start", "WORD", this.#takeCount()), false);
				return;
			case "e":
				this.#applyCharwiseTarget(this.#wordTargetAbs("forward", "end", "word", this.#takeCount()), true);
				return;
			case "E":
				this.#applyCharwiseTarget(this.#wordTargetAbs("forward", "end", "WORD", this.#takeCount()), true);
				return;

			// --- line motions ---
			case "0":
				this.moveToLineStart();
				return;
			case "^":
				this.#moveToFirstNonWs();
				return;
			case "$":
				this.moveToLineEnd();
				return;

			// --- paragraph motions ---
			case "{":
				this.#applyParagraphMotion("backward", this.#takeCount());
				return;
			case "}":
				this.#applyParagraphMotion("forward", this.#takeCount());
				return;

			// --- matching pair ---
			case "%":
				this.#applyMatchingPair();
				return;

			// --- char find ---
			case "f":
			case "F":
			case "t":
			case "T":
				this.#charPending = data;
				return;
			case ";":
				this.#repeatCharFind(false);
				return;
			case ",":
				this.#repeatCharFind(true);
				return;

			// --- buffer jumps ---
			case "g":
				this.#pendingG = true;
				return;
			case "G":
				this.#gotoLine(this.#count === "" ? this.getLines().length - 1 : this.#takeCount() - 1);
				this.#count = "";
				return;

			// --- edits ---
			case "u":
				this.#undo(this.#takeCount());
				return;
			case "x":
				this.#deleteUnderCursor(this.#takeCount());
				return;
			case "r":
				this.#replacePending = true;
				return;
			case "D":
				this.#deleteToLineEnd();
				this.#resetPending();
				return;
			case "C":
				this.#deleteToLineEnd();
				this.setMode("insert");
				return;
			case "d":
				this.#op = "d";
				return;
			case "c":
				this.#op = "c";
				return;
			case "s":
				this.#deleteUnderCursor(this.#takeCount());
				this.setMode("insert");
				return;
			case "y":
				this.#op = "y";
				return;
			case "Y": {
				// `Y` is `yy` in vim: yank the current line (+count-1 below).
				const count = this.#takeCount();
				const { line } = this.getCursor();
				this.#yankLineRange(line, line + count - 1);
				return;
			}
			case "p":
				this.#paste(this.#takeCount(), true);
				return;
			case "P":
				this.#paste(this.#takeCount(), false);
				return;

			case ":":
				this.#startEx();
				return;

			default:
				// Swallow every other key: NORMAL mode must never leak text.
				return;
		}
	}

	// --- visual mode --------------------------------------------------------

	/** Enter (or switch between) VISUAL / VISUAL-LINE, anchoring at the cursor. */
	#enterVisual(mode: "visual" | "visual-line"): void {
		if (this.#mode !== "visual" && this.#mode !== "visual-line") {
			const { line, col } = this.getCursor();
			this.#visualAnchor = { line, col };
		}
		this.#count = "";
		this.setMode(mode);
	}

	/** Drop the selection and return to NORMAL. */
	#exitVisual(): void {
		this.#visualAnchor = null;
		this.setMode("normal");
	}

	/** The anchor, clamped into the current buffer (text may have reflowed). */
	#getVisualAnchor(): VisualPosition {
		const cursor = this.getCursor();
		return clampVisualPosition(this.#visualAnchor ?? cursor, this.getLines());
	}

	/** Absolute `[startAbs, endAbs)` span of the inclusive char-wise selection. */
	#visualCharwiseRange(): { startAbs: number; endAbs: number } {
		const lines = this.getLines();
		const { start, end } = orderVisualEndpoints(this.#getVisualAnchor(), this.getCursor());
		const endLine = lines[end.line] ?? "";
		const includesNewline = end.col >= endLine.length && end.line < lines.length - 1;
		return {
			startAbs: lineColToAbs(lines, start.line, start.col),
			endAbs:
				lineColToAbs(lines, end.line, 0) +
				getInclusiveEndColumn(endLine, end.col) +
				(includesNewline ? 1 : 0),
		};
	}

	/** Swap anchor and cursor so the other end of the selection moves (`o`). */
	#swapVisualEnds(): void {
		const anchor = this.#getVisualAnchor();
		const cursor = this.getCursor();
		this.#visualAnchor = { line: cursor.line, col: cursor.col };
		this.#moveToAbs(lineColToAbs(this.getLines(), anchor.line, anchor.col));
	}

	/**
	 * Apply an operator to the live selection, then leave visual mode. `d`
	 * deletes the span, `c` deletes and enters INSERT, `y` yanks it into the
	 * register (leaving the buffer intact). Charwise or whole-line per `linewise`.
	 */
	#applyVisualOperator(operator: Operator, linewise: boolean): void {
		this.#count = "";
		const anchor = this.#getVisualAnchor();
		const cursor = this.getCursor();

		if (linewise) {
			const { startLine, endLine } = getVisualLineRange(anchor, cursor);
			this.#visualAnchor = null;
			this.setMode("normal");
			if (operator === "c") {
				// #changeLineRange collapses the lines and enters INSERT itself.
				this.#changeLineRange(startLine, endLine);
			} else if (operator === "y") {
				this.#yankLineRange(startLine, endLine);
			} else {
				this.#deleteLineRange(startLine, endLine);
			}
			return;
		}

		const { startAbs, endAbs } = this.#visualCharwiseRange();
		this.#visualAnchor = null;
		if (operator === "y") {
			// Visual charwise yank: capture the span, park at its start, keep buffer.
			this.#yankToRegister(this.getText().slice(startAbs, endAbs), false);
			this.setMode("normal");
			this.#moveToAbs(startAbs);
			return;
		}
		this.setMode(operator === "c" ? "insert" : "normal");
		this.#deleteAbsRange(startAbs, endAbs);
	}

	/**
	 * Non-motion visual keys. Returns true when consumed; motions and counts
	 * return false so they fall through to normal dispatch and resize the
	 * selection by moving the cursor.
	 */
	#handleVisual(data: string): boolean {
		// Let a mid-flight motion prefix (count, `g`, char-find) resolve normally.
		if (this.#pendingG || this.#charPending !== null) return false;

		const linewise = this.#mode === "visual-line";
		switch (data) {
			case "v":
				if (linewise) this.setMode("visual");
				else this.#exitVisual();
				return true;
			case "V":
				if (linewise) this.#exitVisual();
				else this.setMode("visual-line");
				return true;
			case "o":
			case "O":
				this.#swapVisualEnds();
				return true;
			case "d":
			case "x":
				this.#applyVisualOperator("d", linewise);
				return true;
			case "c":
			case "s":
				this.#applyVisualOperator("c", linewise);
				return true;
			case "D":
			case "X":
				this.#applyVisualOperator("d", true);
				return true;
			case "C":
			case "S":
				this.#applyVisualOperator("c", true);
				return true;
			case "y":
				this.#applyVisualOperator("y", linewise);
				return true;
			case "Y":
				this.#applyVisualOperator("y", true);
				return true;
			case "p":
			case "P": {
				// Visual paste replaces the selection with the register (vim). The
				// delete would clobber the register with the removed span, so stash
				// and restore it, then put at the deletion point (`P` semantics:
				// charwise inserts at the cursor, linewise on a line there).
				const saved = this.#register;
				this.#applyVisualOperator("d", linewise);
				this.#register = saved;
				this.#paste(1, false);
				return true;
			}
			case ":":
				return true;

			default:
				return false;
		}
	}

	/** Second key after `d`/`c`: a doubled operator (linewise), `i`/`a`, or a motion. */
	#handleOperatorKey(data: string): void {
		const op = this.#op;
		if (op === null) return;

		// `gg`/`G` as operator motions (`dgg`, `dG`, `cG`): resolved via #gotoLine,
		// whose operator branch deletes/changes the line range to the target.
		if (this.#pendingG) {
			this.#pendingG = false;
			if (data === "g") this.#gotoLine(this.#count === "" ? 0 : this.#takeCount() - 1);
			else this.#resetPending();
			return;
		}
		if (data === "g") {
			this.#pendingG = true;
			return;
		}
		if (data === "G") {
			this.#gotoLine(this.#count === "" ? this.getLines().length - 1 : this.#takeCount() - 1);
			this.#count = "";
			return;
		}

		// `dd` / `cc` / `yy`: linewise on the current line (+count-1 lines below).
		if (
			(op === "d" && data === "d") ||
			(op === "c" && data === "c") ||
			(op === "y" && data === "y")
		) {
			const count = this.#takeCount();
			const { line } = this.getCursor();
			this.#applyLinewiseOperator(op, line, line + count - 1);
			return;
		}

		// Text-object introducer.
		if (data === "i" || data === "a") {
			this.#textObject = data;
			return;
		}

		// Char-find as an operator motion (`df{char}`, `ct{char}`, …).
		if (data === "f" || data === "F" || data === "t" || data === "T") {
			this.#charPending = data;
			return;
		}

		// Linewise vertical operator motions (`dj`/`dk`, `cj`/`ck`, `yj`/`yk`).
		if (data === "j" || data === "k") {
			const count = this.#takeCount();
			const { line } = this.getCursor();
			const other = data === "j" ? line + count : line - count;
			this.#applyLinewiseOperator(op, Math.min(line, other), Math.max(line, other));
			return;
		}

		// Charwise motions reuse the same target math as their bare forms.
		switch (data) {
			case "w":
				if (op === "c") this.#changeWord("word");
				else this.#applyCharwiseTarget(this.#wordTargetAbs("forward", "start", "word", this.#takeCount()), false);
				return;
			case "W":
				if (op === "c") this.#changeWord("WORD");
				else this.#applyCharwiseTarget(this.#wordTargetAbs("forward", "start", "WORD", this.#takeCount()), false);
				return;
			case "b":
				this.#applyCharwiseTarget(this.#wordTargetAbs("backward", "start", "word", this.#takeCount()), false);
				return;
			case "B":
				this.#applyCharwiseTarget(this.#wordTargetAbs("backward", "start", "WORD", this.#takeCount()), false);
				return;
			case "e":
				this.#applyCharwiseTarget(this.#wordTargetAbs("forward", "end", "word", this.#takeCount()), true);
				return;
			case "E":
				this.#applyCharwiseTarget(this.#wordTargetAbs("forward", "end", "WORD", this.#takeCount()), true);
				return;
			case "$": {
				const { line } = this.getCursor();
				const end = (this.getLines()[line] ?? "").length;
				this.#applyCharwiseTarget(lineColToAbs(this.getLines(), line, end), false);
				return;
			}
			case "0": {
				const { line } = this.getCursor();
				this.#applyCharwiseTarget(lineColToAbs(this.getLines(), line, 0), false);
				return;
			}
			case "^":
				this.#applyCharwiseTarget(this.#firstNonWsAbs(), false);
				return;
			case "%":
				this.#applyMatchingPair();
				return;
			case "l": {
				const { line, col } = this.getCursor();
				const text = this.getLines()[line] ?? "";
				let end = col;
				for (let i = 0; i < this.#takeCount() && end < text.length; i++) {
					end += this.#graphemeLenAt(text, end);
				}
				this.#applyCharwiseTarget(lineColToAbs(this.getLines(), line, end), false);
				return;
			}
			default:
				// Unknown motion cancels the operator, vim-style.
				this.#resetPending();
				return;
		}
	}

	/**
	 * Vim `cw`/`cW`: on a non-blank the special-case makes it behave like `ce`
	 * (change to the end of the current word, inclusive); on whitespace there is
	 * no such special-case, so it behaves like `w` (change the whitespace run up
	 * to the next word start, exclusive). Enters INSERT either way.
	 */
	#changeWord(semanticClass: WordMotionClass): void {
		const count = this.#takeCount();
		const { line, col } = this.getCursor();
		const ch = (this.getLines()[line] ?? "")[col];
		const onBlank = ch === undefined || /\s/.test(ch);
		if (onBlank) {
			this.#applyCharwiseTarget(this.#wordTargetAbs("forward", "start", semanticClass, count), false);
		} else {
			this.#applyCharwiseTarget(this.#wordTargetAbs("forward", "end", semanticClass, count), true);
		}
	}

	#resolveCharFind(data: string): void {
		const motion = this.#charPending;
		this.#charPending = null;
		if (motion === null) return;
		// Ignore modifier/control chunks; a char-find target is a printable char.
		if (data.length === 0 || data.charCodeAt(0) < 0x20) {
			this.#resetPending();
			return;
		}
		this.#lastCharMotion = { motion, char: data };
		this.#applyCharFind(motion, data, this.#takeCount(), false);
	}

	#repeatCharFind(reverse: boolean): void {
		const last = this.#lastCharMotion;
		if (last === null) return;
		const motion = reverse ? reverseCharMotion(last.motion) : last.motion;
		this.#applyCharFind(motion, last.char, this.#takeCount(), true);
	}

	#applyCharFind(motion: CharMotion, char: string, count: number, isRepeat: boolean): void {
		const { line, col } = this.getCursor();
		const text = this.getLines()[line] ?? "";
		const targetCol = findCharMotionTarget(text, col, motion, char, isRepeat, count);
		if (targetCol === null) {
			this.#resetPending();
			return;
		}
		// Under an operator, forward f/t are end-inclusive (dfx deletes through x);
		// backward F/T are exclusive of the cursor (dFx deletes [target, cursor)).
		const forward = motion === "f" || motion === "t";
		this.#applyCharwiseTarget(lineColToAbs(this.getLines(), line, targetCol), this.#op !== null && forward);
	}

	#resolveTextObject(objectKey: string): void {
		const kind = this.#textObject;
		const op = this.#op;
		this.#textObject = null;
		if (kind === null || op === null) {
			this.#resetPending();
			return;
		}
		const text = this.getText();
		const cursorAbs = this.#curAbs();
		let range: { startAbs: number; endAbs: number } | null;
		if (objectKey === "w" || objectKey === "W") {
			const { line, col } = this.getCursor();
			const lineStartAbs = lineColToAbs(this.getLines(), line, 0);
			range = resolveWordTextObjectRange(
				this.getLines()[line] ?? "",
				lineStartAbs,
				col,
				kind,
				this.#takeCount(),
				objectKey === "W" ? "WORD" : "word",
			);
		} else {
			range = resolveDelimitedTextObjectRange(text, cursorAbs, kind, objectKey);
		}
		if (range === null) {
			this.#resetPending();
			return;
		}
		if (op === "y") {
			// Text-object yank captures charwise and parks the cursor at the
			// object's start (`yiw`, `ya"`, …).
			this.#yankToRegister(this.getText().slice(range.startAbs, range.endAbs), false);
			this.#moveToAbs(range.startAbs);
			this.#resetPending();
			return;
		}
		this.#deleteAbsRange(range.startAbs, range.endAbs);
		if (op === "c") this.setMode("insert");
		else this.#resetPending();
	}

	#resolveReplace(data: string): void {
		this.#replacePending = false;
		if (data.length === 0 || data.charCodeAt(0) < 0x20) {
			this.#resetPending();
			return;
		}
		const { line, col } = this.getCursor();
		const text = this.getLines()[line] ?? "";
		if (col >= text.length) {
			this.#resetPending();
			return;
		}
		// Replace the grapheme under the cursor, leaving the cursor on it (vim `r`).
		this.handleDraftEdit(SEQ.deleteForward);
		this.insertText(data);
		this.handleDraftEdit(SEQ.left);
		this.#count = "";
	}

	#applyParagraphMotion(direction: "forward" | "backward", count: number): void {
		const lines = this.getLines();
		const { line } = this.getCursor();
		const targetLine = findParagraphMotionTarget(lines, line, direction, count);
		this.#applyCharwiseTarget(lineColToAbs(lines, targetLine, 0), false);
	}

	#applyMatchingPair(): void {
		const text = this.getText();
		const { line } = this.getCursor();
		const lines = this.getLines();
		const lineStartAbs = lineColToAbs(lines, line, 0);
		const lineEndAbs = lineStartAbs + (lines[line] ?? "").length;
		const result = resolveMatchingPairMotionTarget(text, this.#curAbs(), lineStartAbs, lineEndAbs);
		if (result === null) {
			this.#resetPending();
			return;
		}
		this.#applyCharwiseTarget(result.targetAbs, this.#op !== null);
	}

	#firstNonWsAbs(): number {
		const { line } = this.getCursor();
		const lines = this.getLines();
		const text = lines[line] ?? "";
		const col = isBlankLine(text) ? 0 : findFirstNonWhitespaceColumn(text);
		return lineColToAbs(lines, line, col);
	}

	#moveToFirstNonWs(): void {
		const { line } = this.getCursor();
		const text = this.getLines()[line] ?? "";
		this.#moveToColInLine(isBlankLine(text) ? 0 : findFirstNonWhitespaceColumn(text));
	}

	/** `gg` / `G` / `{count}gg` / `{count}G`: jump to a line's first non-blank char. */
	#gotoLine(lineIndex: number): void {
		const lines = this.getLines();
		const target = Math.max(0, Math.min(lineIndex, lines.length - 1));
		if (this.#op !== null) {
			const { line } = this.getCursor();
			this.#applyLinewiseOperator(this.#op, Math.min(line, target), Math.max(line, target));
			return;
		}
		const text = lines[target] ?? "";
		const col = isBlankLine(text) ? 0 : findFirstNonWhitespaceColumn(text);
		this.#moveToAbs(lineColToAbs(lines, target, col));
	}

	/** `x` / `{count}x`: delete count graphemes from under the cursor, one undo unit. */
	#deleteUnderCursor(count: number): void {
		const lines = this.getLines();
		const { line, col } = this.getCursor();
		const text = lines[line] ?? "";
		let end = col;
		for (let i = 0; i < count && end < text.length; i++) end += this.#graphemeLenAt(text, end);
		this.#deleteAbsRange(lineColToAbs(lines, line, col), lineColToAbs(lines, line, end));
	}

	/** Delete from the cursor to the end of the current line, as one undo unit. */
	#deleteToLineEnd(): void {
		const lines = this.getLines();
		const { line, col } = this.getCursor();
		const text = lines[line] ?? "";
		this.#deleteAbsRange(lineColToAbs(lines, line, col), lineColToAbs(lines, line, text.length));
	}

	// --- ex mode -----------------------------------------------------------

	/** Open the ex command buffer. */
	#startEx(): void {
		this.#exCommand = ":";
		this.onExCommandChange?.(":");
	}

	/** Close the ex command buffer without submitting. */
	#clearEx(): void {
		this.#exCommand = null;
		this.onExCommandChange?.(null);
	}

	/** Update the ex command buffer and notify the host. */
	#setEx(next: string): void {
		this.#exCommand = next;
		this.onExCommandChange?.(next);
	}

	/**
	 * Route a keystroke while ex mode is active. Called only when
	 * `#exCommand !== null`; never opens an undo unit.
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
			if (this.#exCommand === ":") {
				this.#clearEx();
			} else {
				this.#setEx(this.#exCommand!.slice(0, -1));
			}
			return;
		}
		// Bracketed paste: extract first line, never auto-submit on embedded newline.
		if (data.includes("\x1b[200~")) {
			const startIdx = data.indexOf("\x1b[200~") + 6; // "\x1b[200~".length
			const endMarker = data.indexOf("\x1b[201~");
			const raw = endMarker === -1 ? data.slice(startIdx) : data.slice(startIdx, endMarker);
			const nlIdx = raw.search(/[\r\n]/);
			const firstLine = nlIdx === -1 ? raw : raw.slice(0, nlIdx);
			this.#setEx(this.#exCommand! + firstLine);
			return;
		}
		// Non-printable control chunk not handled above: bail out of ex mode.
		if (data.length > 0 && data.charCodeAt(0) < 0x20) {
			this.#clearEx();
			return;
		}
		// Printable character: append to buffer.
		this.#setEx(this.#exCommand! + data);
	}

	/**
	 * Submit the current ex command buffer. Clears ex mode first, then
	 * dispatches through the resolution order inherited from upstream pi-vim.
	 */
	#submitEx(): void {
		const command = (this.#exCommand ?? "").slice(1).trim();
		this.#clearEx();
		if (!command) return;

		// 1. Quit family: :q / :qa / :quit / :qall / :quitall (with optional !)
		const force = command.endsWith("!");
		const quitName = force ? command.slice(0, -1) : command;
		if (Object.hasOwn(ModalVimEditor.#QUIT_NAMES, quitName)) {
			if (!force && this.getText().trim().length > 0) {
				this.notifyUser?.(`Prompt is not empty; use :${command}! to quit anyway`);
				return;
			}
			this.onQuit?.();
			return;
		}

		// 2. Shell passthrough: :!cmd or :!!cmd
		if (command.startsWith("!")) {
			const shell = command.replace(/^!+/, "").trim();
			if (shell) {
				this.#dispatchEx(command);
			} else {
				this.notifyUser?.(`Unsupported ex command: :${command}`);
			}
			return;
		}

		// 3. Split into name and args.
		const sep = command.search(/\s/);
		const name = sep === -1 ? command : command.slice(0, sep);
		const args = sep === -1 ? "" : command.slice(sep + 1).trim();
		const bareName = name.endsWith("!") ? name.slice(0, -1) : name;

		// 4. Reserved commands (line-address / range operations, `:w`, etc.).
		if (Object.hasOwn(ModalVimEditor.#RESERVED_NAMES, bareName)) {
			this.notifyUser?.(`Reserved ex command: :${name}`);
			return;
		}

		// 5. Known slash command registered with the host.
		if (this.getCommandNames?.().has(name)) {
			this.#dispatchEx(args ? `/${name} ${args}` : `/${name}`);
			return;
		}

		// 6. Unknown.
		this.notifyUser?.(`Unsupported ex command: :${command}`);
	}

	/**
	 * Dispatch `commandLine` through the host, then synchronously restore the
	 * draft buffer + cursor so the submission never eats the user's prompt.
	 * An async submit path also re-restores when the promise settles if the
	 * buffer was cleared.
	 */
	#dispatchEx(commandLine: string): void {
		const text = this.getText();
		const { line, col } = this.getCursor();

		let r: void | Promise<void>;
		if (this.runExCommand !== undefined) {
			r = this.runExCommand(commandLine);
		} else {
			this.setText(commandLine);
			r = this.onSubmit?.(commandLine);
		}

		// Synchronous restore.
		this.setText(text);
		this.#moveToAbs(lineColToAbs(this.getLines(), line, col));

		// Async restore: some hosts clear the buffer after awaiting the promise.
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
}

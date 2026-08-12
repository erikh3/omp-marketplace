import { getLineGraphemes } from "../vim/motions.js";

/**
 * Offset/keystep bridge between the vendored pure motion logic and omp's base
 * editor.
 *
 * The pure functions in `motions.ts` / `text-objects.ts` speak in **UTF-16
 * offsets** — either a column within one line or an absolute offset into the
 * full buffer text (lines joined by `\n`). omp's base editor exposes no cursor
 * setter; it only moves by **one grapheme** per replayed arrow/delete key. This
 * module converts between the two worlds so the editor can turn a computed
 * target into a count of key presses that lands exactly on it, staying
 * grapheme- and undo-correct because every move still goes through the base
 * editor's own key handling.
 *
 * Also contains the `moveCursor` replay loop extracted from `modal-editor.ts`'s
 * `#moveToAbs` / `#moveToColInLine`. The editor retains the actual
 * `handleDraftEdit` / `moveToMessageStart` / `moveToLineStart` primitives;
 * this module only computes *which* keys to send and *how many*, then delegates
 * each key to the caller-supplied `replay` callback.
 */

/** Raw terminal byte sequences for the four arrow directions. */
const SEQ = {
	left: "\x1b[D",
	right: "\x1b[C",
	up: "\x1b[A",
	down: "\x1b[B",
} as const;

/** Absolute UTF-16 offset of `(line, col)` within the full buffer text. */
export function lineColToAbs(lines: readonly string[], line: number, col: number): number {
	let abs = 0;
	// Each preceding line contributes its own length plus the `\n` that joins it
	// to the next; the buffer text is `lines.join("\n")`.
	for (let i = 0; i < line; i++) abs += (lines[i]?.length ?? 0) + 1;
	return abs + col;
}

/** `(line, col)` for an absolute UTF-16 offset within the full buffer text. */
export function absToLineCol(lines: readonly string[], abs: number): { line: number; col: number } {
	let remaining = Math.max(0, abs);
	for (let i = 0; i < lines.length; i++) {
		const len = lines[i]?.length ?? 0;
		// `remaining <= len` (not `<`) so an offset sitting on the trailing `\n`
		// resolves to end-of-this-line rather than start-of-next.
		if (remaining <= len) return { line: i, col: remaining };
		remaining -= len + 1;
	}
	const last = Math.max(0, lines.length - 1);
	return { line: last, col: lines[last]?.length ?? 0 };
}

/**
 * Grapheme-cluster count of an arbitrary slice (may contain `\n`, which is its
 * own cluster). This is the number of forward-delete presses that remove the
 * slice — newlines included, since deleting a `\n` joins two lines.
 */
export function graphemeCount(slice: string): number {
	return getLineGraphemes(slice).length;
}

/**
 * Number of grapheme clusters between two columns of a single line — i.e. how
 * many left/right key presses move the base editor's cursor from `startCol` to
 * `endCol`. Direction-agnostic (returns a non-negative count); the caller picks
 * the arrow key.
 */
export function graphemeSteps(line: string, startCol: number, endCol: number): number {
	const lo = Math.max(0, Math.min(startCol, endCol));
	const hi = Math.max(startCol, endCol);
	return graphemeCount(line.slice(lo, hi));
}

/**
 * A view of the buffer that the replay loop reads — the minimal surface the
 * bridge needs from the editor. The editor implements this via its own
 * `getLines()` / `getCursor()`.
 *
 * NOTE: `BufferView` / `Pos` are defined in §5.2 of the architecture doc
 * (`src/host/adapter.ts`). They don't exist yet (Task 4), so we define minimal
 * local types here to keep this module self-contained.
 */
export interface BridgeCursorView {
	getLines(): readonly string[];
	getCursor(): { line: number; col: number };
}

/**
 * Move the cursor to an absolute buffer offset by replaying arrow keys.
 *
 * This is the replay loop extracted from `modal-editor.ts`'s `#moveToAbs` +
 * `#moveToColInLine`. The exact move order is **line delta first (up/down),
 * then column delta (left/right)** — this order is load-bearing because the
 * base editor's EOL clamp corrects any column overshoot that would land off the
 * end of the target line, and because `moveToMessageStart` anchors at line 0
 * before counting down.
 *
 * @param view     Read-only view of the buffer (getLines + getCursor).
 * @param abs      Target absolute UTF-16 offset.
 * @param controls Editor primitives for navigation/replay:
 *   - `moveToMessageStart()` — jump to buffer start (line 0, col 0).
 *   - `moveToLineStart()` — jump to start of current line.
 *   - `replay(seq, n)` — send `seq` to the base editor `n` times.
 */
export function moveCursorToAbs(
	view: BridgeCursorView,
	abs: number,
	controls: {
		moveToMessageStart(): void;
		moveToLineStart(): void;
		replay(seq: string, n: number): void;
	},
): void {
	const { line, col } = absToLineCol(view.getLines(), abs);

	// 1. Anchor at buffer start.
	controls.moveToMessageStart();

	// 2. Walk down to the target logical line. The guard prevents infinite loops
	//    if the base editor stops advancing (e.g. cursor is on the last line).
	let guard = 0;
	while (view.getCursor().line < line && guard++ < 100000) {
		const before = view.getCursor();
		controls.replay(SEQ.down, 1);
		const after = view.getCursor();
		// If pressing down didn't move us, we've hit the last navigable line.
		if (after.line === before.line && after.col === before.col) break;
	}

	// 3. Jump to the start of the target line, then walk right to the target col.
	controls.moveToLineStart();
	const currentLine = view.getLines()[view.getCursor().line] ?? "";
	const steps = graphemeSteps(currentLine, 0, col);
	if (steps > 0) controls.replay(SEQ.right, steps);
}

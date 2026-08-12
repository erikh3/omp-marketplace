import { getLineGraphemes } from "./motions.js";

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
 */

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

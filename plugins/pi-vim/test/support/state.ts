/**
 * Cursor-marker buffer states.
 *
 * A test buffer is written as a plain string with a single marker char (default
 * `|`) at the cursor. `parseState` strips the marker and returns the buffer text
 * plus the (line, col) the cursor sits at; `renderState` re-inserts the marker so
 * assertions compare whole, human-legible buffers ("the |quick") instead of a
 * bare column number.
 *
 * `line`/`col` are UTF-16 offsets, matching the base editor's `getCursor()`.
 */

export interface EditorState {
	text: string;
	line: number;
	col: number;
}

/** Parse a cursor-marker string into buffer text + cursor position. */
export function parseState(marked: string, marker = "|"): EditorState {
	const idx = marked.indexOf(marker);
	if (idx === -1) {
		throw new Error(`no cursor marker ${JSON.stringify(marker)} in ${JSON.stringify(marked)}`);
	}
	if (marked.indexOf(marker, idx + marker.length) !== -1) {
		throw new Error(`multiple cursor markers ${JSON.stringify(marker)} in ${JSON.stringify(marked)}`);
	}
	const text = marked.slice(0, idx) + marked.slice(idx + marker.length);
	const before = text.slice(0, idx);
	const line = (before.match(/\n/g) ?? []).length;
	const lineStart = before.lastIndexOf("\n") + 1; // 0 when the cursor is on the first line
	const col = idx - lineStart;
	return { text, line, col };
}

/** Render buffer text + cursor position back into a cursor-marker string. */
export function renderState(state: EditorState, marker = "|"): string {
	const lines = state.text.split("\n");
	const line = Math.max(0, Math.min(state.line, lines.length - 1));
	const lineText = lines[line] ?? "";
	const col = Math.max(0, Math.min(state.col, lineText.length));
	lines[line] = lineText.slice(0, col) + marker + lineText.slice(col);
	return lines.join("\n");
}

/**
 * Keystroke notation → raw terminal byte chunks.
 *
 * A vim-like notation string is expanded into the ordered chunks handed to
 * `editor.handleInput`, so tests read like key logs. Angle-bracket tokens map to
 * the control/escape sequences the editor speaks; `[paste]…[/paste]` wraps a
 * bracketed paste; every other code point is a literal printable key, emitted one
 * code point per chunk (matching how the interactive editor receives typing).
 *
 * The byte values here mirror the constants in `src/modal-editor.ts` and
 * `src/vim/types.ts`, so the DSL and the code under test cannot drift.
 */

/** Angle-bracket token → raw bytes. */
const TOKENS: Record<string, string> = {
	Esc: "\x1b",
	"C-[": "\x1b",
	CR: "\r",
	Enter: "\r",
	"C-r": "\x12", // Ctrl+r — vim redo
	BS: "\x7f", // backspace (ex editing)
	Up: "\x1b[A",
	Down: "\x1b[B",
	Right: "\x1b[C",
	Left: "\x1b[D",
	lt: "<", // literal '<'
};

const PASTE_OPEN = "\x1b[200~";
const PASTE_CLOSE = "\x1b[201~";

/**
 * Expand `notation` into the ordered raw chunks for `handleInput`.
 *
 * - `<Esc>`, `<CR>`, `<C-r>`, `<BS>`, `<Up>`/`<Down>`/`<Left>`/`<Right>`, `<lt>`
 *   → their byte sequence (see {@link TOKENS}).
 * - `[paste]TEXT[/paste]` → one chunk wrapped in bracketed-paste markers.
 * - anything else → one chunk per code point.
 */
export function keys(notation: string): string[] {
	const out: string[] = [];
	let i = 0;
	while (i < notation.length) {
		if (notation.startsWith("[paste]", i)) {
			const end = notation.indexOf("[/paste]", i);
			const inner = end === -1 ? notation.slice(i + 7) : notation.slice(i + 7, end);
			out.push(PASTE_OPEN + inner + PASTE_CLOSE);
			i = end === -1 ? notation.length : end + "[/paste]".length;
			continue;
		}
		if (notation[i] === "<") {
			const end = notation.indexOf(">", i);
			if (end !== -1) {
				const token = notation.slice(i + 1, end);
				const bytes = TOKENS[token];
				if (bytes !== undefined) {
					out.push(bytes);
					i = end + 1;
					continue;
				}
			}
			// Unknown `<…>`: fall through and treat `<` as a literal character.
		}
		const cp = String.fromCodePoint(notation.codePointAt(i)!);
		out.push(cp);
		i += cp.length;
	}
	return out;
}

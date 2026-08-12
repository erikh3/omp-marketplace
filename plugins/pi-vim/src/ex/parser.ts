/**
 * Pure parser for the ex command line. No host refs, no side effects.
 *
 * Lifts the parse logic from `ModalVimEditor.#submitEx` /
 * `ModalVimEditor.#dispatchEx` so it can be unit-tested and reused without
 * any editor dependency.
 */

/**
 * The structured result of parsing a raw ex command line (the text after the
 * leading `:`).
 *
 * - `command` — a named command with optional trailing args
 * - `search`  — a `/pattern` search-style line (currently shell passthrough
 *               `!cmd` also falls through to `command` with `name="!…"`)
 * - `empty`   — the line was blank after trimming
 */
export type ExParse =
	| { kind: "command"; name: string; args: string; raw: string }
	| { kind: "search"; pattern: string }
	| { kind: "empty" };

/**
 * Quit-family names (`:q` / `:qa` / `:quit` / `:qall` / `:quitall`).
 * Checked via `Object.hasOwn` to guard against prototype-chain keys.
 */
export const QUIT_NAMES: Record<string, true> = {
	q: true,
	qa: true,
	quit: true,
	qall: true,
	quitall: true,
};

/**
 * Ex commands reserved for future line-address / range support. A registered
 * command whose name collides with a reserved name is **silenced** — the
 * reserved flag takes precedence.
 */
export const RESERVED_NAMES: Record<string, true> = {
	s: true,
	g: true,
	v: true,
	d: true,
	m: true,
	t: true,
	co: true,
	j: true,
	w: true,
	r: true,
	normal: true,
	sort: true,
	"&": true,
	">": true,
	"<": true,
};

/**
 * Parse the text accumulated in the ex buffer (everything **after** the
 * leading `:`).
 *
 * - Empty / whitespace-only → `{ kind: "empty" }`.
 * - Starts with `!` → shell passthrough: `{ kind: "command", name: "!…", args: "" }`.
 *   The full raw token (e.g. `"!ls"` or `"!!git status"`) is returned as
 *   `name` so `commands.ts` can decide whether to dispatch or notify.
 * - Otherwise: splits on first whitespace to extract `name` + `args`.
 */
export function parseExLine(line: string): ExParse {
	const command = line.trim();
	if (!command) return { kind: "empty" };

	// Shell passthrough: :!cmd or :!!cmd
	if (command.startsWith("!")) {
		return { kind: "command", name: command, args: "", raw: command };
	}

	// Split into name and args on first whitespace.
	const sep = command.search(/\s/);
	const name = sep === -1 ? command : command.slice(0, sep);
	const args = sep === -1 ? "" : command.slice(sep + 1).trim();

	return { kind: "command", name, args, raw: command };
}

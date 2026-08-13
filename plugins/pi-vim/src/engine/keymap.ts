/**
 * Keymap — declarative key→command descriptor tables per mode.
 *
 * This is the single canonical file listing every key binding. A contributor
 * wanting to know "what does `X` do in NORMAL mode?" reads this file first.
 *
 * `Command` is a discriminated union; the dispatch evaluator looks up the key
 * here and routes to the appropriate registry function.
 */

import type { Operator } from "./state.js";

// ---------------------------------------------------------------------------
// Command discriminated union
// ---------------------------------------------------------------------------

/** A charwise motion that optionally awaits a second key (char-find, `r`). */
export type MotionCommand =
	| { type: "motion"; name: string; inclusiveOverride?: boolean; changeWord?: boolean }
	| { type: "motion-await-char"; name: "f" | "F" | "t" | "T" }
	| { type: "motion-G" }     // G or {count}G — needs "has count?" flag
	| { type: "motion-gg" };   // gg — pending-g state

/** An operator (`d`, `c`, `y`) sets operator-pending. */
export type OperatorCommand = { type: "operator"; name: Operator };

/** A standalone action that takes no motion. */
export type ActionCommand = { type: "action"; name: string };

/** `i` / `a` inside operator-pending introduces a text-object. */
export type TextObjectIntro = { type: "textobject-intro"; kind: "i" | "a" };

export type Command =
	| MotionCommand
	| OperatorCommand
	| ActionCommand
	| TextObjectIntro;

// ---------------------------------------------------------------------------
// Per-mode key tables
// ---------------------------------------------------------------------------

/**
 * NORMAL-mode commands. These are the first-key entries (no pending state).
 * The evaluator handles pending states (operator, charPending, pendingG, etc.)
 * BEFORE consulting this table.
 */
export const normalKeymap: Readonly<Record<string, Command>> = {
	// Mode entries
	i: { type: "action", name: "i" },
	a: { type: "action", name: "a" },
	I: { type: "action", name: "I" },
	A: { type: "action", name: "A" },
	o: { type: "action", name: "o" },
	O: { type: "action", name: "O" },

	// Visual modes
	v: { type: "action", name: "v" },
	V: { type: "action", name: "V" },

	// Ex
	":": { type: "action", name: ":" },

	// Cursor motions — arrow-like
	h: { type: "motion", name: "h" },
	l: { type: "motion", name: "l" },
	j: { type: "motion", name: "j" },
	k: { type: "motion", name: "k" },

	// Word motions
	w: { type: "motion", name: "w" },
	W: { type: "motion", name: "W" },
	b: { type: "motion", name: "b" },
	B: { type: "motion", name: "B" },
	e: { type: "motion", name: "e" },
	E: { type: "motion", name: "E" },

	// Line motions
	"0": { type: "motion", name: "0" },
	"^": { type: "motion", name: "^" },
	$: { type: "motion", name: "$" },

	// Paragraph motions
	"{": { type: "motion", name: "{" },
	"}": { type: "motion", name: "}" },

	// Matching pair
	"%": { type: "motion", name: "%" },

	// Char-find
	f: { type: "motion-await-char", name: "f" },
	F: { type: "motion-await-char", name: "F" },
	t: { type: "motion-await-char", name: "t" },
	T: { type: "motion-await-char", name: "T" },

	// Char-find repeat
	";": { type: "action", name: ";" },
	",": { type: "action", name: "," },

	// Buffer jumps
	g: { type: "motion-gg" },
	G: { type: "motion-G" },

	// Operators
	d: { type: "operator", name: "d" },
	c: { type: "operator", name: "c" },
	y: { type: "operator", name: "y" },

	// Edits
	x: { type: "action", name: "x" },
	X: { type: "action", name: "X" },
	s: { type: "action", name: "s" },
	S: { type: "action", name: "S" },
	r: { type: "action", name: "r" },
	D: { type: "action", name: "D" },
	C: { type: "action", name: "C" },
	Y: { type: "action", name: "Y" },
	J: { type: "action", name: "J" },
	p: { type: "action", name: "p" },
	P: { type: "action", name: "P" },

	// First non-whitespace (counted line-down); linewise under an operator.
	_: { type: "motion", name: "_" },

	// Dot-repeat
	".": { type: "action", name: "." },
	// Undo / redo
	u: { type: "action", name: "u" },
	// ctrl+r is handled separately (canonical key id)
};

/**
 * Keys available inside OPERATOR-PENDING (after d/c/y).
 * Only motions and text-object introductions are valid here.
 * NOT listed here → evaluator resets pending (vim cancels the operator).
 */
export const operatorKeymap: Readonly<Record<string, Command>> = {
	// Doubled operators (dd/cc/yy): handled specially as action "dd"/"cc"/"yy"
	// - mapped dynamically in dispatch based on which operator is pending

	// Text-object introducer
	i: { type: "textobject-intro", kind: "i" },
	a: { type: "textobject-intro", kind: "a" },

	// Char-find as operator motion
	f: { type: "motion-await-char", name: "f" },
	F: { type: "motion-await-char", name: "F" },
	t: { type: "motion-await-char", name: "t" },
	T: { type: "motion-await-char", name: "T" },

	// Linewise motions
	j: { type: "motion", name: "j" },
	k: { type: "motion", name: "k" },

	// Charwise motions
	w: { type: "motion", name: "w", changeWord: true },
	W: { type: "motion", name: "W", changeWord: true },
	b: { type: "motion", name: "b" },
	B: { type: "motion", name: "B" },
	e: { type: "motion", name: "e" },
	E: { type: "motion", name: "E" },
	"0": { type: "motion", name: "0" },
	"^": { type: "motion", name: "^" },
	$: { type: "motion", name: "$" },
	"%": { type: "motion", name: "%", inclusiveOverride: true },
	l: { type: "motion", name: "l-op" }, // special: clamped to text.length

	// Line jumps (linewise under operator)
	g: { type: "motion-gg" },
	G: { type: "motion-G" },
	_: { type: "motion", name: "_" },
};

/**
 * Keys consumed by VISUAL mode that are NOT motions (operators, mode toggles,
 * paste, `o`). These are handled before checking the normal keymap.
 */
export const visualActionKeymap: Readonly<Record<string, string>> = {
	// Toggle charwise ↔ linewise / exit
	v: "visual-v",
	V: "visual-V",

	// Visual operators
	d: "visual-d",
	x: "visual-d",
	c: "visual-c",
	s: "visual-c",
	D: "visual-D",
	X: "visual-D",
	C: "visual-C",
	S: "visual-C",
	y: "visual-y",
	Y: "visual-Y",

	// Paste in visual
	p: "visual-p",
	P: "visual-p",

	// Swap ends
	o: "visual-o",
	O: "visual-o",

	// Ex (swallowed)
	":": "visual-:",
};

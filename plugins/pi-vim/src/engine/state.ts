/**
 * Typed state machine for the vim engine.
 *
 * Replaces the 11 scattered private fields on ModalVimEditor with one owned
 * struct. All mutations happen through the exported helpers so the invariants
 * are in one place.
 *
 * InputState shape: mirrored 1:1 from the original boolean/nullable flags
 * (`operator`, `textObject`, `charPending`, `replacePending`, `pendingG`) so
 * the storage swap is purely structural — no semantic merging of the pending
 * discriminants, which would risk subtle reset-timing regressions.
 *
 * `register` and `keys` fields are present for future named-register support
 * and dot-repeat (Tasks N) but are unused today; they are never read by the
 * current dispatch and are reset by `resetInput` along with everything else.
 */

import type { VimMode } from "../host/adapter.js";
import type { CharMotion } from "../vim/types.js";
import type { TextObjectKind } from "../vim/text-objects.js";
import { RegisterFile } from "./registers.js";

/** The three vim operators supported today. */
export type Operator = "d" | "c" | "y";

/** Accumulated input for the command being built. */
export interface InputState {
	/** Digit prefix typed before the command (e.g. `"12"` for `12j`). `""` = none. */
	count: string;
	/** Pending operator set by `d`/`c`/`y`; null until first key. */
	operator: Operator | null;
	/** Set after `i`/`a` inside an operator; next key is the text-object. */
	textObject: TextObjectKind | null;
	/** Set after `f`/`F`/`t`/`T`; next key is the find-target character. */
	charPending: CharMotion | null;
	/** Set after `r`; next key replaces the grapheme under the cursor. */
	replacePending: boolean;
	/** True after first `g`, awaiting a second `g` to complete `gg`. */
	pendingG: boolean;
	/**
	 * Named-register selector: set by `"` in NORMAL mode.
	 * Unused today; present so named-register dispatch can read it later.
	 */
	register: string | null;
	/**
	 * Raw key sequence of the command in flight — for dot-repeat capture.
	 * Unused today; present so `.` replay can accumulate keys as they arrive.
	 */
	keys: string[];
}

/**
 * Snapshot of a completed mutating command for `.` repeat.
 * The evaluator copies `input.keys` into `lastChange` at the command boundary.
 * Unused today; present so `.` can be wired without new state fields.
 */
export type RecordedCommand = { keys: readonly string[] };

/** Complete modal-editor state — the one struct owning every piece of mutable vim state. */
export interface VimState {
	mode: VimMode;
	input: InputState;
	/** Fixed end of the visual selection (`v`/`V`); null when not in visual. */
	visualAnchor: { line: number; col: number } | null;
	registers: RegisterFile;
	/** Most recently completed mutating command (for `.` repeat). */
	lastChange: RecordedCommand | null;
	/** Last `f`/`F`/`t`/`T` for `;`/`,` repeat. */
	lastCharMotion: { motion: CharMotion; char: string } | null;
	/** Ex command buffer (`":"…`); null when ex mode is inactive. */
	exBuffer: string | null;
}

/** Construct a fresh InputState with all fields zeroed. */
export function makeInputState(): InputState {
	return {
		count: "",
		operator: null,
		textObject: null,
		charPending: null,
		replacePending: false,
		pendingG: false,
		register: null,
		keys: [],
	};
}

/** Construct the initial VimState (INSERT mode, no pending input, empty register). */
export function makeVimState(): VimState {
	return {
		mode: "insert",
		input: makeInputState(),
		visualAnchor: null,
		registers: new RegisterFile(),
		lastChange: null,
		lastCharMotion: null,
		exBuffer: null,
	};
}

/**
 * Clear all pending-command fields in `InputState`, matching the exact fields
 * that the original `#resetPending()` cleared (`count`, `operator`,
 * `textObject`, `charPending`, `replacePending`, `pendingG`).
 * The future fields (`register`, `keys`) are also cleared here so they never
 * bleed across commands.
 */
export function resetInput(s: VimState): void {
	s.input.count = "";
	s.input.operator = null;
	s.input.textObject = null;
	s.input.charPending = null;
	s.input.replacePending = false;
	s.input.pendingG = false;
	s.input.register = null;
	s.input.keys = [];
}

/**
 * Consume and return the numeric count prefix, defaulting to 1.
 * Matches the original `#takeCount()` exactly: `parseInt` on the accumulated
 * string, clamp to `[1, 9999]`, clear the field.
 */
export function takeCount(s: VimState): number {
	const n = s.input.count === "" ? 1 : Number.parseInt(s.input.count, 10);
	s.input.count = "";
	return Math.min(Math.max(Number.isFinite(n) ? n : 1, 1), 9999);
}

/**
 * True when any component of a multi-key command is in flight.
 * Matches the original `#hasPending()` predicate field-for-field.
 */
export function hasPending(s: VimState): boolean {
	return (
		s.input.count !== "" ||
		s.input.operator !== null ||
		s.input.textObject !== null ||
		s.input.charPending !== null ||
		s.input.replacePending ||
		s.input.pendingG
	);
}

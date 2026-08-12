/** One point on pi-vim's own undo/redo timeline: the full buffer text plus the
 * cursor to restore it to. */
export interface Snapshot {
	text: string;
	line: number;
	col: number;
}

/** Cap on each history stack so a long session can't grow it without bound. */
const MAX_HISTORY = 500;

/**
 * Dumb snapshot stack that owns pi-vim's undo/redo timeline.
 *
 * Has no reference to the editor; callers supply snapshots and receive them
 * back. The editor remains responsible for applying (restoring) a returned
 * snapshot.
 */
export class History {
	#undo: Snapshot[] = [];
	#redo: Snapshot[] = [];
	#pending: Snapshot | null = null;

	/**
	 * Mark the start of a change: record the pre-edit state so a later
	 * {@link commit} can push it onto the undo stack.  No-op if a change is
	 * already open, so an insert session (many keystrokes) collapses to one unit.
	 */
	begin(text: string, cursor: { line: number; col: number }): void {
		if (this.#pending === null) {
			this.#pending = { text, line: cursor.line, col: cursor.col };
		}
	}

	/**
	 * Close the change opened by {@link begin}.  Pushes the pre-edit snapshot
	 * onto the undo stack (clearing the redo stack, as any new edit does in vim)
	 * only when the buffer text actually changed, so pure motions and no-op edits
	 * leave the timeline untouched.
	 *
	 * @param text - the current buffer text after the edit (used for comparison).
	 */
	commit(text: string): void {
		const before = this.#pending;
		this.#pending = null;
		if (before === null || before.text === text) return;
		this.#undo.push(before);
		if (this.#undo.length > MAX_HISTORY) this.#undo.shift();
		this.#redo.length = 0;
	}

	/**
	 * Discard any open pending snapshot without committing.  Called by `u` and
	 * `Ctrl+r` so the surrounding begin/commit wrapper in handleInput becomes a
	 * no-op.
	 */
	cancelPending(): void {
		this.#pending = null;
	}

	/**
	 * Pop the most-recent undo entry and stash `current` for redo.
	 * Returns the snapshot to restore, or `null` if the stack is empty.
	 */
	undo(current: Snapshot): Snapshot | null {
		const prev = this.#undo.pop();
		if (prev === undefined) return null;
		this.#redo.push(current);
		return prev;
	}

	/**
	 * Pop the most-recent redo entry and stash `current` for undo.
	 * Returns the snapshot to restore, or `null` if the stack is empty.
	 */
	redo(current: Snapshot): Snapshot | null {
		const next = this.#redo.pop();
		if (next === undefined) return null;
		this.#undo.push(current);
		return next;
	}
}

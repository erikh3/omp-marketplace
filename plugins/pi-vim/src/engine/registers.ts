/**
 * Vim register storage with an optional system-clipboard mirror.
 *
 * The unnamed register is always kept in an internal shadow. When a
 * {@link ClipboardPort} is injected, register writes may additionally mirror
 * to the OS clipboard and reads may prefer it (read-on-put), matching upstream
 * lajarre/pi-vim's clipboard policy:
 *
 *   - `"all"`   mirrors every unnamed write (yanks and deletes/changes).
 *   - `"yank"`  mirrors yanks only; deletes/changes stay shadow-local.
 *   - `"never"` mirrors nothing; the shadow is authoritative.
 *
 * `get()` prefers the OS clipboard only when the LAST write was actually
 * mirrored (so a policy-skipped delete never trusts a stale OS clipboard) and
 * a port is present; otherwise it returns the shadow.
 *
 * The optional `_name` parameter is present but unused so a future
 * named-register feature can add routing without changing existing call sites.
 */

/** How unnamed-register writes mirror to the OS clipboard. */
export type ClipboardMirror = "all" | "yank" | "never";

/**
 * Sync surface pi-vim drives for the OS clipboard. The concrete port lives in
 * the host layer; the engine depends only on this interface so it stays pure
 * and testable with a fake.
 */
export interface ClipboardPort {
	/** Fire-and-forget write of the unnamed-register text to the OS clipboard. */
	write(text: string): void;
	/** Best-effort synchronous read of the current OS clipboard text, or null. */
	peek(): string | null;
}

/** Which kind of edit produced a register write (drives the mirror policy). */
export type RegisterWriteKind = "yank" | "delete";

export interface Register {
	text: string;
	linewise: boolean;
}

export class RegisterFile {
	#unnamed: Register | null = null;
	readonly #port: ClipboardPort | null;
	readonly #mirror: ClipboardMirror;
	/** Whether the most recent write was mirrored to the OS clipboard. */
	#lastWriteMirrored = false;

	constructor(port: ClipboardPort | null = null, mirror: ClipboardMirror = "all") {
		this.#port = port;
		this.#mirror = mirror;
	}

	/**
	 * Store the unnamed register. `kind` classifies the write so the mirror
	 * policy can distinguish yanks from deletes; omitting it (an internal
	 * save/restore) never mirrors.
	 */
	set(reg: Register, kind?: RegisterWriteKind, _name?: string): void {
		this.#unnamed = reg;
		const shouldMirror =
			this.#port !== null &&
			kind !== undefined &&
			(this.#mirror === "all" || (this.#mirror === "yank" && kind === "yank"));
		if (shouldMirror) {
			this.#port?.write(reg.text);
			this.#lastWriteMirrored = true;
		} else {
			this.#lastWriteMirrored = false;
		}
	}

	get(_name?: string): Register | null {
		if (this.#lastWriteMirrored && this.#port !== null) {
			const os = this.#port.peek();
			if (os !== null) {
				return { text: os, linewise: os.endsWith("\n") };
			}
		}
		return this.#unnamed;
	}

	/** Reset the register back to null (needed for save/restore patterns). */
	clear(_name?: string): void {
		this.#unnamed = null;
		this.#lastWriteMirrored = false;
	}
}

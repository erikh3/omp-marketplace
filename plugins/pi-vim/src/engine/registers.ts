/**
 * Vim register storage.
 *
 * Minimal RegisterFile: unnamed register only. The optional `_name` parameter
 * is present but unused so a future named-register feature (Task N) can add
 * routing without changing the call sites already using the unnamed form.
 */
export interface Register {
	text: string;
	linewise: boolean;
}

export class RegisterFile {
	#unnamed: Register | null = null;

	get(_name?: string): Register | null {
		return this.#unnamed;
	}

	set(reg: Register, _name?: string): void {
		this.#unnamed = reg;
	}

	/** Reset the register back to null (needed for save/restore patterns). */
	clear(_name?: string): void {
		this.#unnamed = null;
	}
}

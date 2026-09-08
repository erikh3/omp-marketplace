/**
 * Git commit message cleanup — a pure implementation of Git's four cleanup
 * modes as described in `git-commit(1)`.
 *
 * No I/O. No side effects.
 */

import type { CleanupMode } from "./types.ts";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface CleanupOptions {
	/** The cleanup mode to apply. */
	readonly mode: CleanupMode;
	/**
	 * The effective comment character for this repository.
	 * Resolved from `core.commentChar`; absent means `#`.
	 * The value `"auto"` is only valid when the resolved effective mode does
	 * not interpret comments (i.e. `verbatim` or `whitespace`). Callers must
	 * confirm this before passing `"auto"` here.
	 */
	readonly commentChar: string;
	/**
	 * True when the message originates from a non-editor source (`-m`, `-F`,
	 * `-C`). For these sources `default` resolves to `whitespace`. For the
	 * supported noninteractive `-c` path `default` resolves to `strip`.
	 * Also controls whether `scissors` truncates or merely whitespace-cleans.
	 */
	readonly nonEditorSource: boolean;
}

/**
 * Resolve `"default"` to its concrete mode without applying cleanup.
 *
 * Exported so callers can check whether the resolved mode requires comment
 * interpretation before deciding how to handle `core.commentChar=auto`.
 */
export function resolveEffectiveMode(
	mode: CleanupMode,
	nonEditorSource: boolean,
): Exclude<CleanupMode, "default"> {
	if (mode !== "default") return mode;
	return nonEditorSource ? "whitespace" : "strip";
}

/**
 * Apply Git commit-message cleanup to `raw`.
 *
 * When `mode` resolves to `strip` or `scissors` the `commentChar` is used to
 * identify comment lines. Pass `"#"` for the Git default. Do not pass `"auto"`
 * unless you have confirmed the resolved mode is `verbatim` or `whitespace`.
 */
export function applyCleanup(raw: string, opts: CleanupOptions): string {
	const effective = resolveEffectiveMode(opts.mode, opts.nonEditorSource);

	switch (effective) {
		case "verbatim":
			return raw;

		case "whitespace":
			return applyWhitespace(raw);

		case "strip":
			return applyStrip(raw, opts.commentChar);

		case "scissors":
			return applyScissors(raw, opts.commentChar, opts.nonEditorSource);
	}
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Whitespace cleanup:
 *   - Strip trailing whitespace from every line.
 *   - Collapse runs of consecutive blank lines into a single blank line.
 *   - Trim leading and trailing blank lines from the result.
 *   - Preserve comment lines.
 */
function applyWhitespace(raw: string): string {
	const lines = raw.split("\n");

	// Strip trailing whitespace from each line.
	const stripped = lines.map((l) => l.replace(/\s+$/, ""));

	// Collapse consecutive blank lines and trim leading/trailing blanks.
	const out: string[] = [];
	let prevBlank = true; // treat start as blank so leading empties are dropped
	for (const line of stripped) {
		const blank = line === "";
		if (blank && prevBlank) continue;
		out.push(line);
		prevBlank = blank;
	}

	// Trim trailing blank line (prevBlank is true when the last pushed line was blank).
	if (out.length > 0 && out[out.length - 1] === "") {
		out.pop();
	}

	return out.join("\n");
}

/**
 * Strip cleanup: whitespace cleanup, then remove all comment lines, then
 * re-apply whitespace to handle newly-adjacent blank lines.
 */
function applyStrip(raw: string, commentChar: string): string {
	const afterWs = applyWhitespace(raw);
	if (afterWs === "") return "";
	const withoutComments = afterWs
		.split("\n")
		.filter((l) => !l.startsWith(commentChar))
		.join("\n");
	return applyWhitespace(withoutComments);
}

/**
 * Scissors cleanup.
 *
 * Editor path: truncate at the scissors marker, then apply whitespace cleanup.
 * The scissors line itself and everything after it is discarded.
 *
 * Non-editor path: Git does not apply scissors truncation for `-m`, `-F`, or
 * `-C` sources, so the scissors line is treated as data and only whitespace
 * cleanup is applied.
 */
function applyScissors(
	raw: string,
	commentChar: string,
	nonEditorSource: boolean,
): string {
	if (nonEditorSource) {
		return applyWhitespace(raw);
	}
	const lines = raw.split("\n");
	const scissorsPrefix = `${commentChar} `;
	const cutIdx = lines.findIndex((l) => {
		if (!l.startsWith(scissorsPrefix)) return false;
		const rest = l.slice(scissorsPrefix.length);
		return /^-{8,} >8 -{8,}$/.test(rest);
	});
	const before = cutIdx === -1 ? lines : lines.slice(0, cutIdx);
	return applyWhitespace(before.join("\n"));
}

/**
 * Pure formatting functions for git-commit-linter diagnostic output.
 *
 * All functions are stateless and return plain strings. No I/O, no side effects.
 */

import type { LintRuleOutcome } from "@commitlint/types";

/**
 * Maximum number of Unicode code points shown in a commit header preview.
 * Shared with the orchestrator so both sides agree on what "bounded" means.
 */
export const HEADER_PREVIEW_LIMIT = 72;

/**
 * Normalize a raw string for single-line display:
 *   - Replace every ASCII control character (U+0000–U+001F, U+007F) with a space.
 *   - Take only the first line (split on \n, \r\n, or \r).
 *   - Truncate to HEADER_PREVIEW_LIMIT Unicode code points, appending "…" when cut.
 */
export function formatHeaderPreview(raw: string): string {
	// Take the first logical line before any line break.
	const firstLine = raw.split(/\r\n|\r|\n/)[0] ?? "";

	// Replace ASCII control characters with a space.
	// U+0000–U+001F and U+007F are the C0 and DEL control characters.
	const normalized = firstLine.replace(/[\x00-\x1F\x7F]/g, " ");

	// Truncate by Unicode code points (not UTF-16 code units).
	const codePoints = [...normalized];
	if (codePoints.length <= HEADER_PREVIEW_LIMIT) {
		return normalized;
	}
	// Leave one code-point slot for the ellipsis.
	return codePoints.slice(0, HEADER_PREVIEW_LIMIT - 1).join("") + "\u2026";
}

/**
 * Format a parser or resolver failure that prevented the commit message from
 * being determined. Used when the Bash call must be blocked before execution.
 *
 * @param reason  Human-readable explanation of why analysis failed.
 * @param rawCommand  The raw command text, used only to produce a header
 *                    preview for context. May be empty.
 */
export function formatBlockReason(reason: string, rawCommand: string): string {
	const preview = rawCommand.trim() ? formatHeaderPreview(rawCommand) : "";
	const lines: string[] = ["git commit blocked: commit message could not be resolved."];
	if (preview) {
		lines.push(`Command: ${preview}`);
	}
	lines.push(`Reason: ${reason}`);
	return lines.join("\n");
}

/**
 * Format commitlint violations into a single block-reason string.
 *
 * Includes a bounded header preview followed by one line per error in the form
 * `[rule-name] message`. Warnings are never included. Bodies are never included.
 *
 * @param header  The raw commit subject line (first line of the message).
 * @param errors  The error outcomes from @commitlint/lint.
 */
export function formatLintErrors(
	header: string,
	errors: ReadonlyArray<LintRuleOutcome>,
): string {
	const preview = formatHeaderPreview(header);
	const errorLines = errors.map((e) => `[${e.name}] ${e.message}`);
	return [
		`git commit blocked: commit message failed lint checks.`,
		`Header: ${preview}`,
		...errorLines,
	].join("\n");
}

/**
 * Format the post-result warning injected into a tool_result when the
 * repository commitlint config was broken.
 *
 * The text states that linting was skipped and that the commit may have
 * already executed. It does not suggest retrying.
 *
 * @param repoConfigError  The raw error message from the broken config load.
 * @param worktreeRoot     The Git worktree root where the broken config lives.
 */
export function formatBrokenConfigWarning(
	repoConfigError: string,
	worktreeRoot: string,
): string {
	return [
		"Warning: commit linting was skipped for this call.",
		`The repository commitlint config at ${worktreeRoot} could not be loaded, so no message validation ran. The commit may have already executed.`,
		`Config error: ${repoConfigError}`,
		"Fix the repository config to restore linting.",
	].join("\n");
}

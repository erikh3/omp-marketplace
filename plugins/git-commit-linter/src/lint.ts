/**
 * Commitlint adapter for git-commit-linter.
 *
 * Calls @commitlint/lint with the qualified config fields and returns a
 * CommitLintResult. Does not block on warnings; only errors cause a block.
 */

import lint from "@commitlint/lint";
import type { CommitInvocation, CommitLintResult, EffectiveLintConfig } from "./types.ts";

/**
 * Lint one cleaned commit message against the effective config.
 *
 * Forwards to @commitlint/lint:
 *   - qualified `rules`
 *   - `parserPreset.parserOpts`
 *   - qualified `plugins`
 *   - qualified `ignores` (function-valued; present only in repo configs)
 *   - `defaultIgnores`
 *   - `helpUrl`
 */
export async function lintCommit(
	message: string,
	invocation: CommitInvocation,
	repoRoot: string,
	config: EffectiveLintConfig,
): Promise<CommitLintResult> {
	const { commitlint } = config;

	const outcome = await lint(message, commitlint.rules, {
		parserOpts: commitlint.parserPreset?.parserOpts as Record<string, unknown> | undefined,
		plugins: commitlint.plugins,
		ignores: commitlint.ignores,
		defaultIgnores: commitlint.defaultIgnores,
		helpUrl: commitlint.helpUrl,
	});

	return {
		repoRoot,
		invocation,
		message,
		valid: outcome.valid,
		errors: outcome.errors,
		warnings: outcome.warnings,
	};
}

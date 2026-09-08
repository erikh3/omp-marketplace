import type { QualifiedConfig, LintRuleOutcome } from "@commitlint/types";

// ---------------------------------------------------------------------------

/** The result of analyzing a raw Bash command for git commit invocations. */
export type ShellAnalysis =
	| { readonly kind: "no-commit" }
	| { readonly kind: "commits"; readonly invocations: readonly CommitInvocation[] }
	| { readonly kind: "blocked"; readonly reason: string };

// ---------------------------------------------------------------------------
// Commit invocation
// ---------------------------------------------------------------------------

/**
 * A statically resolved `git commit` simple command extracted from a Bash
 * call, before repository or message resolution.
 */
export interface CommitInvocation {
	/** Byte span of the git command word in the original command string. */
	readonly tokenStart: number;
	readonly tokenEnd: number;

	/** Effective working directory at the point this command executes. */
	readonly effectiveCwd: string;

	/** Git global options present before the `commit` subcommand. */
	readonly gitGlobalOptions: GitGlobalOptions;

	/** Commit-specific options parsed from the argument list. */
	readonly commitOptions: CommitOptions;

	/** How the commit message is supplied. */
	readonly messageSource: MessageSource;

	/** Explicit `--cleanup` override, if present. */
	readonly cleanupOverride: CleanupMode | undefined;

	/** True for commits whose message is fully Git-generated (fixup, squash, etc.). */
	readonly isGeneratedMessage: boolean;
}

/** Git global options that can appear before the subcommand. */
export interface GitGlobalOptions {
	readonly C: readonly string[];
	readonly gitDir: string | undefined;
	readonly workTree: string | undefined;
	readonly namespace: string | undefined;
	readonly execPath: string | undefined;
	readonly noPager: boolean;
	/** Raw environment variable assignments preceding the git word. */
	readonly leadingAssignments: ReadonlyMap<string, string>;
}

/** Commit flag options relevant to message sourcing and linting. */
export interface CommitOptions {
	readonly amend: boolean;
	readonly noEdit: boolean;
	readonly fixup: string | undefined;
	readonly squash: string | undefined;
	readonly allowEmptyMessage: boolean;
}

/** Git `--cleanup` mode values. */
export type CleanupMode = "strip" | "whitespace" | "verbatim" | "scissors" | "default";

// ---------------------------------------------------------------------------
// Message source
// ---------------------------------------------------------------------------

/** Where the commit message comes from, before cleanup. */
export type MessageSource =
	| {
			readonly kind: "inline";
			/** Paragraphs from repeated `-m` flags, to be joined with `\n\n` before cleanup. */
			readonly paragraphs: readonly string[];
	  }
	| {
			readonly kind: "file";
			/** Path as written in the argument (resolved against effectiveCwd at resolution time). */
			readonly path: string;
	  }
	| {
			readonly kind: "reuse-commit";
			/** Revision argument to `-C` / `--reuse-message`. */
			readonly revision: string;
	  }
	| {
			readonly kind: "reedit-commit";
			/** Revision argument to `-c` / `--reedit-message`. */
			readonly revision: string;
	  }
	| { readonly kind: "generated" }
	| { readonly kind: "amend-no-edit" }
	| { readonly kind: "editor-bound" };

// ---------------------------------------------------------------------------
// Resolved commit
// ---------------------------------------------------------------------------

/**
 * A commit invocation after repository and message resolution.
 * Only `lint` resolutions proceed to the commitlint adapter.
 */
export type ResolvedCommit =
	| {
			readonly resolution: "lint";
			readonly invocation: CommitInvocation;
			/** Git worktree root (absolute path). */
			readonly repoRoot: string;
			/** Cleaned commit message ready for linting. */
			readonly message: string;
	  }
	| {
			readonly resolution: "skip";
			readonly invocation: CommitInvocation;
			readonly repoRoot: string;
	  }
	| {
			readonly resolution: "outside-repository";
			readonly invocation: CommitInvocation;
	  }
	| {
			readonly resolution: "blocked";
			readonly invocation: CommitInvocation;
			readonly reason: string;
	  };

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * The behavior section under `gitCommitLinter` in a plugin JSONC config.
 * Currently accepts no keys; unknown keys are rejected.
 */
export type GitCommitLinterBehavior = Record<never, never>;

/**
 * The effective merged configuration passed to the lint adapter.
 * Holds a fully qualified commitlint config plus the plugin behavior object.
 */
export interface EffectiveLintConfig {
	readonly commitlint: QualifiedConfig;
	readonly gitCommitLinter: GitCommitLinterBehavior;
}

/**
 * The outcome of attempting to load and merge configuration for one repository
 * root during a Bash tool call.
 */
export type ConfigLoadResult =
	| {
			readonly kind: "ready";
			readonly config: EffectiveLintConfig;
	  }
	| {
			/**
			 * A repository commitlint config file was detected but could not be loaded.
			 * Linting is skipped for this Bash call; Bash still executes.
			 */
			readonly kind: "broken-repository-config";
			readonly error: unknown;
	  }
	| {
			/**
			 * The plugin JSONC config or seed load failed. The entire Bash call is blocked.
			 */
			readonly kind: "fatal";
			readonly error: unknown;
	  };

// ---------------------------------------------------------------------------
// Lint result
// ---------------------------------------------------------------------------

/**
 * The outcome of linting one resolved commit message.
 * `errors` and `warnings` are `LintRuleOutcome[]` from `@commitlint/types`.
 */
export interface CommitLintResult {
	readonly repoRoot: string;
	readonly invocation: CommitInvocation;
	/** The cleaned message that was linted. */
	readonly message: string;
	readonly valid: boolean;
	readonly errors: readonly LintRuleOutcome[];
	readonly warnings: readonly LintRuleOutcome[];
}

// ---------------------------------------------------------------------------
// Pending warning
// ---------------------------------------------------------------------------

/**
 * A deferred broken-repository-config warning stored in the extension factory
 * closure until the matching `tool_result` arrives.
 */
export interface PendingWarning {
	readonly toolCallId: string;
	/** Pre-formatted warning text to prepend to the tool result content. */
	readonly formattedRepoConfigError: string;
}

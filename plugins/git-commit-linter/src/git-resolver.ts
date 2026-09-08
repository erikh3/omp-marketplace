/**
 * Git repository and message resolution for git-commit-linter.
 *
 * All Git queries run as short-lived, read-only argument-array subprocesses.
 * No shell strings, no writes, no index or worktree mutations.
 */

import { resolve, isAbsolute } from "node:path";
import type { CommitInvocation, CleanupMode, ResolvedCommit } from "./types.ts";
import { applyCleanup, resolveEffectiveMode } from "./message-cleanup.ts";

// ---------------------------------------------------------------------------
// Timeout budget
// ---------------------------------------------------------------------------

/**
 * Hard limit per Git subprocess in milliseconds.
 * Four queries per invocation × 2 s = 8 s worst case, well below OMP's
 * default 30-second extension-handler timeout.
 */
const GIT_QUERY_TIMEOUT_MS = 2000;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Resolve one `CommitInvocation` to a `ResolvedCommit`.
 *
 * - Runs real Git subprocesses to locate the worktree and read commit bodies.
 * - Returns `outside-repository` when Git reports no worktree.
 * - Returns `skip` for generated/amend-no-edit invocations (no linting needed).
 * - Returns `blocked` on any subprocess error, timeout, unresolvable source,
 *   or `core.commentChar=auto` with a cleanup mode that needs it.
 * - Returns `lint` with the cleaned message when all resolution succeeds.
 */
export async function resolveCommit(
	invocation: CommitInvocation,
): Promise<ResolvedCommit> {
	// Generated messages (fixup, squash, merge state) and amend-no-edit are
	// skipped unconditionally; no repository resolution needed.
	if (
		invocation.isGeneratedMessage ||
		invocation.messageSource.kind === "generated" ||
		invocation.messageSource.kind === "amend-no-edit"
	) {
		// We still need the repo root for the skip record; attempt resolution.
		// Outside the repo → outside-repository. Valid repo → skip.
		// Unexpected Git/spawn/timeout failure → blocked (not a silent skip
		// with an empty root, which would hide real infrastructure problems).
		const rootResult = await resolveWorktreeRoot(invocation);
		if (rootResult.ok) {
			return { resolution: "skip", invocation, repoRoot: rootResult.root };
		}
		if (rootResult.outside) {
			return { resolution: "outside-repository", invocation };
		}
		return {
			resolution: "blocked",
			invocation,
			reason: `git worktree resolution failed: ${rootResult.error}`,
		};
	}

	// Editor-bound commits can never be pre-resolved.
	if (invocation.messageSource.kind === "editor-bound") {
		return {
			resolution: "blocked",
			invocation,
			reason:
				"commit is editor-bound: the message is not available before Bash executes",
		};
	}

	// Resolve worktree root.
	const rootResult = await resolveWorktreeRoot(invocation);
	if (rootResult.outside) {
		return { resolution: "outside-repository", invocation };
	}
	if (!rootResult.ok) {
		return {
			resolution: "blocked",
			invocation,
			reason: `git worktree resolution failed: ${rootResult.error}`,
		};
	}
	const repoRoot = rootResult.root;

	// Load repository Git config values needed for cleanup.
	const configResult = await loadGitConfig(repoRoot);
	if (!configResult.ok) {
		return {
			resolution: "blocked",
			invocation,
			reason: `git config query failed: ${configResult.error}`,
		};
	}

	// Resolve raw message text.
	const rawResult = await resolveRawMessage(invocation, repoRoot);
	if (!rawResult.ok) {
		return {
			resolution: "blocked",
			invocation,
			reason: rawResult.reason,
		};
	}

	// Determine effective cleanup mode and check commentChar compatibility.
	const explicitCleanup = invocation.cleanupOverride;
	const repoCleanup = configResult.commitCleanup;
	const mode: CleanupMode = explicitCleanup ?? repoCleanup ?? "default";

	// Non-editor sources: `-m`, `-F`, `-C`. The `-c` path is non-interactive
	// (GIT_EDITOR=true) so Git still technically uses the editor path, meaning
	// default resolves to `strip` for `-c`.
	const nonEditorSource = rawResult.nonEditorSource;

	const effectiveMode = resolveEffectiveMode(mode, nonEditorSource);
	const commentChar = configResult.commentChar ?? "#";

	// Block when commentChar=auto and the mode requires comment interpretation.
	if (
		configResult.commentCharAuto &&
		(effectiveMode === "strip" || effectiveMode === "scissors")
	) {
		return {
			resolution: "blocked",
			invocation,
			reason:
				"core.commentChar=auto with cleanup mode that requires comment interpretation; " +
				"cannot determine effective comment character before execution",
		};
	}

	const message = applyCleanup(rawResult.raw, {
		mode,
		commentChar,
		nonEditorSource,
	});

	return { resolution: "lint", invocation, repoRoot, message };
}

// ---------------------------------------------------------------------------
// Worktree resolution
// ---------------------------------------------------------------------------

type WorktreeResult =
	| { ok: true; root: string; outside?: never; error?: never }
	| { ok: false; outside: true; root?: never; error?: never }
	| { ok: false; outside?: never; root?: never; error: string };

async function resolveWorktreeRoot(
	invocation: CommitInvocation,
): Promise<WorktreeResult> {
	// Build git -C ... args from the invocation.
	const gitArgs = buildGitBaseArgs(invocation);
	gitArgs.push("rev-parse", "--show-toplevel");

	const result = await runGit(gitArgs, invocation.effectiveCwd);
	if (!result.ok) {
		// Git exits 128 when not in a repository.
		if (result.exitCode === 128) {
			return { ok: false, outside: true };
		}
		return { ok: false, error: result.stderr.trim() || `exit code ${result.exitCode}` };
	}
	const root = result.stdout.trim();
	if (!root) {
		return { ok: false, error: "git rev-parse returned empty toplevel" };
	}
	return { ok: true, root };
}

// ---------------------------------------------------------------------------
// Git config
// ---------------------------------------------------------------------------

interface GitConfigValues {
	ok: true;
	commitCleanup: CleanupMode | undefined;
	/** Effective comment char. `undefined` means absent (use "#"). */
	commentChar: string | undefined;
	/** True when core.commentChar=auto. */
	commentCharAuto: boolean;
}

type GitConfigResult = GitConfigValues | { ok: false; error: string };

async function loadGitConfig(repoRoot: string): Promise<GitConfigResult> {
	// Use `git config --list --null` without a scope flag so Git merges
	// system, global, and local config in the correct precedence order.
	// This matches what `git commit` itself sees at runtime.
	const result = await runGit(["config", "--list", "--null"], repoRoot);

	// On failure (e.g. timeout, spawn error) return safe defaults so the
	// commit can still be linted with the default cleanup mode.
	if (!result.ok) {
		return {
			ok: true,
			commitCleanup: undefined,
			commentChar: undefined,
			commentCharAuto: false,
		};
	}

	// NUL-delimited key\nvalue\0 pairs from --null.
	const entries = result.stdout.split("\0").filter((s) => s.length > 0);

	let commitCleanup: CleanupMode | undefined;
	let commentChar: string | undefined;
	let commentCharAuto = false;

	for (const entry of entries) {
		const eqIdx = entry.indexOf("\n");
		if (eqIdx === -1) continue;
		const key = entry.slice(0, eqIdx).toLowerCase();
		const val = entry.slice(eqIdx + 1);

		if (key === "commit.cleanup") {
			const mode = parseCleanupMode(val);
			if (mode !== undefined) commitCleanup = mode;
		} else if (key === "core.commentchar") {
			if (val === "auto") {
				commentCharAuto = true;
				commentChar = undefined;
			} else {
				commentCharAuto = false;
				commentChar = val.length > 0 ? val : "#";
			}
		}
	}

	return { ok: true, commitCleanup, commentChar, commentCharAuto };
}

function parseCleanupMode(val: string): CleanupMode | undefined {
	switch (val) {
		case "strip":
		case "whitespace":
		case "verbatim":
		case "scissors":
		case "default":
			return val;
		default:
			return undefined;
	}
}

// ---------------------------------------------------------------------------
// Raw message resolution
// ---------------------------------------------------------------------------

interface RawMessageResult {
	ok: true;
	raw: string;
	/** True for -m, -F, -C. False for -c (editor path, even if no-op). */
	nonEditorSource: boolean;
}

type RawResult =
	| RawMessageResult
	| { ok: false; reason: string };

async function resolveRawMessage(
	invocation: CommitInvocation,
	repoRoot: string,
): Promise<RawResult> {
	const source = invocation.messageSource;

	switch (source.kind) {
		case "inline": {
			// Join repeated -m paragraphs with double newline as Git does.
			const raw = source.paragraphs.join("\n\n");
			return { ok: true, raw, nonEditorSource: true };
		}

		case "file": {
			// Resolve path relative to effective cwd.
			const filePath = isAbsolute(source.path)
				? source.path
				: resolve(invocation.effectiveCwd, source.path);

			let text: string;
			try {
				const f = Bun.file(filePath);
				const exists = await f.exists();
				if (!exists) {
					return {
						ok: false,
						reason: `commit message file does not exist: ${filePath}`,
					};
				}
				text = await f.text();
			} catch (err) {
				return {
					ok: false,
					reason: `cannot read commit message file ${filePath}: ${String(err)}`,
				};
			}
			return { ok: true, raw: text, nonEditorSource: true };
		}

		case "reuse-commit": {
			// -C: reuse the selected commit message verbatim (then clean).
			const msgResult = await readCommitMessage(repoRoot, source.revision);
			if (!msgResult.ok) {
				return {
					ok: false,
					reason: `cannot read commit ${source.revision}: ${msgResult.error}`,
				};
			}
			return { ok: true, raw: msgResult.message, nonEditorSource: true };
		}

		case "reedit-commit": {
			// -c: only supported when editor is effectively noninteractive (GIT_EDITOR=true).
			// The caller (resolver entry point) is responsible for verifying no dynamic
			// editor override is present before routing here; if it arrives here the
			// editor check already passed. Git still uses the editor path for -c even
			// when GIT_EDITOR=true, so default cleanup is strip (nonEditorSource=false).
			const msgResult = await readCommitMessage(repoRoot, source.revision);
			if (!msgResult.ok) {
				return {
					ok: false,
					reason: `cannot read commit ${source.revision}: ${msgResult.error}`,
				};
			}
			return { ok: true, raw: msgResult.message, nonEditorSource: false };
		}

		case "generated":
		case "amend-no-edit":
			// These are handled before reaching this point.
			return { ok: false, reason: "unexpected generated/amend-no-edit in raw resolution" };

		case "editor-bound":
			return { ok: false, reason: "editor-bound commit cannot be resolved" };
	}
}

// ---------------------------------------------------------------------------
// Git subprocess helpers
// ---------------------------------------------------------------------------

interface GitSuccess {
	ok: true;
	stdout: string;
	stderr: string;
	exitCode: number;
}

interface GitFailure {
	ok: false;
	stdout: string;
	stderr: string;
	exitCode: number;
}

type GitRunResult = GitSuccess | GitFailure;

async function runGit(
	args: readonly string[],
	cwd: string,
): Promise<GitRunResult> {
	let proc: Bun.Subprocess;
	try {
		proc = Bun.spawn(["git", ...args], {
			cwd,
			stdout: "pipe",
			stderr: "pipe",
			stdin: "inherit",
			env: process.env,
		});
	} catch (err) {
		// spawn itself failed (e.g. git not found)
		return {
			ok: false,
			stdout: "",
			stderr: String(err),
			exitCode: -1,
		};
	}

	let timerId!: Timer;

	if (!(proc.stdout instanceof ReadableStream) || !(proc.stderr instanceof ReadableStream)) {
		return {
			ok: false,
			stdout: "",
			stderr: "unexpected result shape from git spawn",
			exitCode: -1,
		};
	}

	const normalResult = Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);

	const timeoutResult = new Promise<GitFailure>((resolve) => {
		timerId = setTimeout(() => {
			proc.kill();
			resolve({
				ok: false,
				stdout: "",
				stderr: `git timed out after ${GIT_QUERY_TIMEOUT_MS}ms`,
				exitCode: -1,
			});
		}, GIT_QUERY_TIMEOUT_MS);
	});

	try {
		const winner = await Promise.race([normalResult, timeoutResult]);
		if (Array.isArray(winner)) {
			const [stdoutBuf, stderrBuf, exitCode] = winner;
			const ok = exitCode === 0;
			return ok
				? { ok: true, stdout: stdoutBuf, stderr: stderrBuf, exitCode }
				: { ok: false, stdout: stdoutBuf, stderr: stderrBuf, exitCode };
		}
		// timeout resolved
		return winner;
	} finally {
		clearTimeout(timerId);
	}
}

async function readCommitMessage(
	repoRoot: string,
	revision: string,
): Promise<{ ok: true; message: string } | { ok: false; error: string }> {
	const result = await runGit(
		["log", "-1", "--format=%B", revision],
		repoRoot,
	);
	if (!result.ok) {
		return { ok: false, error: result.stderr.trim() || `exit code ${result.exitCode}` };
	}
	// git log --format=%B adds a trailing newline; preserve it for cleanup to handle.
	return { ok: true, message: result.stdout };
}

/**
 * Build the git argument prefix that mirrors the invocation's global options
 * (`-C` flags and `--git-dir` / `--work-tree` when present).
 */
function buildGitBaseArgs(invocation: CommitInvocation): string[] {
	const args: string[] = [];
	for (const c of invocation.gitGlobalOptions.C) {
		args.push("-C", c);
	}
	if (invocation.gitGlobalOptions.gitDir !== undefined) {
		args.push("--git-dir", invocation.gitGlobalOptions.gitDir);
	}
	if (invocation.gitGlobalOptions.workTree !== undefined) {
		args.push("--work-tree", invocation.gitGlobalOptions.workTree);
	}
	return args;
}

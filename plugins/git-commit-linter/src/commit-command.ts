/**
 * Git commit recognition and static cwd tracking.
 *
 * Takes the `SimpleCommand[]` produced by shell-parser.ts and returns a
 * `ShellAnalysis` result. For each simple command:
 *
 *   1. Strip leading NAME=value assignments.
 *   2. Check for the literal `git` command word.
 *   3. Parse Git global options (including repeated `-C`).
 *   4. Require the literal subcommand `commit`.
 *   5. Parse commit options in attached, equals, and separate forms.
 *   6. Resolve the message source and detect conflicting sources.
 *   7. Block on any unresolved expansion, indirect wrapper, or forbidden pattern.
 *
 * Static cwd is tracked across `&&`/`;`/newline for literal `cd` commands.
 * The command splitter hands us `SimpleCommand[]` already, so separator
 * semantics are implicit in array order.
 */

import { splitCommands } from "./shell-parser.ts";
import type { ShellToken, SimpleCommand } from "./shell-parser.ts";
import type {
	ShellAnalysis,
	CommitInvocation,
	GitGlobalOptions,
	CommitOptions,
	MessageSource,
	CleanupMode,
} from "./types.ts";

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Stable reason codes for blocked analysis. Tests assert on these.
 * Codes mirror the lexer's BlockedCode where applicable; the rest are new.
 */
export type CommitBlockedCode =
	| "expansion-in-git-word"
	| "expansion-in-subcommand"
	| "expansion-in-message"
	| "expansion-in-path"
	| "expansion-in-revision"
	| "expansion-in-cleanup"
	| "expansion-in-cwd"
	| "indirect-wrapper"
	| "heredoc-input"
	| "conflicting-message-source"
	| "unknown-global-option"
	| "unknown-commit-option"
	| "malformed-option"
	| "dynamic-cd"
	| "editor-bound-unresolvable";

/**
 * Analyze a raw Bash command for `git commit` invocations.
 *
 * @param rawCommand  The full raw Bash command string.
 * @param baseCwd     The effective working directory when the Bash command starts.
 */
export function analyzeCommand(rawCommand: string, baseCwd: string): ShellAnalysis {
	const splitResult = splitCommands(rawCommand);

	if (splitResult.kind === "blocked") {
		return { kind: "blocked", reason: splitResult.reason };
	}

	const invocations: CommitInvocation[] = [];
	let cwd = baseCwd;

	for (const cmd of splitResult.commands) {
		const result = analyzeSimpleCommand(cmd, cwd);

		if (result.kind === "blocked") {
			return { kind: "blocked", reason: result.reason };
		}

		if (result.kind === "commit") {
			invocations.push(result.invocation);
		} else if (result.kind === "cd") {
			// Track static cd changes; dynamic cd already returned blocked.
			cwd = result.newCwd;
		}
		// result.kind === "other" — ignore
	}

	if (invocations.length === 0) {
		return { kind: "no-commit" };
	}
	return { kind: "commits", invocations };
}

// ---------------------------------------------------------------------------
// Per-command analysis
// ---------------------------------------------------------------------------

type CommandResult =
	| { readonly kind: "commit"; readonly invocation: CommitInvocation }
	| { readonly kind: "cd"; readonly newCwd: string }
	| { readonly kind: "other" }
	| { readonly kind: "blocked"; readonly reason: string };

function analyzeSimpleCommand(cmd: SimpleCommand, cwd: string): CommandResult {
	if (cmd.tokens.length === 0) return { kind: "other" };

	// Strip leading environment assignments (NAME=value) and collect them.
	let idx = 0;
	const leadingAssignments = new Map<string, string>();

	while (idx < cmd.tokens.length) {
		const tok = cmd.tokens[idx]!;
		const assignMatch = tok.value.match(/^([A-Za-z_][A-Za-z0-9_]*)=([\s\S]*)$/);
		if (!assignMatch) break;

		// If the value part has expansion we can still record the name; the
		// expansion check happens when the assignment is used in a critical context.
		if (tok.hasExpansion) {
			// The name part is safe; the value is unresolved. We record it as-is
			// so callers can flag it if it affects a critical field.
			leadingAssignments.set(assignMatch[1]!, tok.value.slice(assignMatch[1]!.length + 1));
		} else {
			leadingAssignments.set(assignMatch[1]!, assignMatch[2]!);
		}
		idx++;
	}

	if (idx >= cmd.tokens.length) return { kind: "other" }; // only assignments

	// Check for `env` wrapper (env VAR=val ... cmd)
	const firstTok = cmd.tokens[idx]!;
	if (firstTok.value === "env" && !firstTok.hasExpansion) {
		idx++;
		// Consume env options and VAR=value assignments that follow `env`.
		// The loop restarts after -i/-u so any assignments that follow them are
		// still captured before the command token is identified.
		while (idx < cmd.tokens.length) {
			const t = cmd.tokens[idx]!;
			// -- terminates option parsing for env itself
			if (t.value === "--") {
				idx++;
				break;
			}
			// -i: clear-environment flag, takes no argument; keep scanning
			if (t.value === "-i") {
				idx++;
				continue;
			}
			// -u NAME: unset a variable; consume NAME and keep scanning
			if (t.value === "-u") {
				idx++;
				if (idx < cmd.tokens.length) idx++; // consume the NAME argument
				continue;
			}
			// VAR=value assignment
			if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t.value)) {
				const m = t.value.match(/^([A-Za-z_][A-Za-z0-9_]*)=([\s\S]*)$/);
				if (m) leadingAssignments.set(m[1]!, m[2]!);
				idx++;
				continue;
			}
			// Dynamic assignment like $VAR=val — block (semantics unknown)
			if (t.hasExpansion && /=/.test(t.value)) {
				return blocked(
					"dynamic assignment in env arguments: semantics cannot be determined statically",
					"expansion-in-message",
				);
			}
			// Anything else is the command
			break;
		}
	}

	if (idx >= cmd.tokens.length) return { kind: "other" };
	const commandTok = cmd.tokens[idx]!;

	// -----------------------------------------------------------------
	// Indirect wrappers: bash -c, sh -c, eval, xargs, find, etc.
	// -----------------------------------------------------------------
	const indirectWrappers = new Set(["bash", "sh", "zsh", "dash", "eval", "xargs"]);
	if (indirectWrappers.has(commandTok.value) && !commandTok.hasExpansion) {
		// Check if any remaining argument looks like a git commit command
		const restTokens = cmd.tokens.slice(idx + 1);
		const restValue = restTokens.map((t) => t.value).join(" ");
		if (/\bgit\b.*\bcommit\b/.test(restValue)) {
			return blocked(
				"indirect wrapper detected: git commit nested inside a shell wrapper cannot be statically analyzed",
				"indirect-wrapper",
			);
		}
		return { kind: "other" };
	}

	// find -exec ... git commit
	if (commandTok.value === "find" && !commandTok.hasExpansion) {
		const restTokens = cmd.tokens.slice(idx + 1);
		const restValue = restTokens.map((t) => t.value).join(" ");
		if (/\bgit\b.*\bcommit\b/.test(restValue)) {
			return blocked(
				"indirect wrapper detected: git commit inside find -exec cannot be statically analyzed",
				"indirect-wrapper",
			);
		}
		return { kind: "other" };
	}

	// -----------------------------------------------------------------
	// Static cd tracking
	// -----------------------------------------------------------------
	if (commandTok.value === "cd" && !commandTok.hasExpansion) {
		return analyzeCd(cmd.tokens.slice(idx + 1), cwd);
	}

	// pushd / popd — block only if a commit follows (conservative: block always
	// when we see them since they affect cwd of subsequent commands)
	if ((commandTok.value === "pushd" || commandTok.value === "popd") && !commandTok.hasExpansion) {
		return blocked(
			`${commandTok.value} affects cwd dynamically and cannot be tracked statically`,
			"dynamic-cd",
		);
	}

	// -----------------------------------------------------------------
	// git command
	// -----------------------------------------------------------------
	// An expansion-active command word could be `git` — block when the rest
	// of the command looks like a `commit` invocation (literal `commit` ahead).
	if (commandTok.hasExpansion) {
		const rest = cmd.tokens.slice(idx + 1);
		if (rest.some((t) => !t.hasExpansion && t.value === "commit")) {
			return blocked(
				"expansion in git command word: the git executable is not statically resolvable",
				"expansion-in-git-word",
			);
		}
		return { kind: "other" };
	}
	if (commandTok.value !== "git") return { kind: "other" };

	idx++;

	// Heredoc input to git directly blocks
	if (cmd.hasHeredocInput) {
		return blocked(
			"stdin heredoc/here-string input to git commit is not statically resolvable",
			"heredoc-input",
		);
	}

	// Parse Git global options
	const globalResult = parseGitGlobalOptions(cmd.tokens, idx, leadingAssignments, cwd);
	if (globalResult.kind === "blocked") return globalResult;

	idx = globalResult.nextIdx;

	if (idx >= cmd.tokens.length) {
		// `git` alone or `git <global-options>` with no subcommand
		return { kind: "other" };
	}

	const subcmdTok = cmd.tokens[idx]!;

	if (subcmdTok.hasExpansion) {
		// Expansion in subcommand — only block if it might be `commit`
		return blocked(
			"expansion in git subcommand: cannot determine whether this is git commit",
			"expansion-in-subcommand",
		);
	}

	if (subcmdTok.value !== "commit") {
		// Non-commit subcommand (including aliases like `ci`): pass untouched
		return { kind: "other" };
	}

	idx++;

	// -----------------------------------------------------------------
	// Parse git commit options
	// -----------------------------------------------------------------
	const commitResult = parseCommitOptions(cmd.tokens, idx);
	if (commitResult.kind === "blocked") return commitResult;

	const { commitOptions, messageSource, cleanupOverride, isGeneratedMessage } = commitResult;

	// Compute effective cwd after applying git -C options
	let effectiveCwd = cwd;
	for (const c of globalResult.gitGlobalOptions.C) {
		effectiveCwd = resolvePath(effectiveCwd, c);
	}

	const invocation: CommitInvocation = {
		tokenStart: commandTok.start,
		tokenEnd: commandTok.end,
		effectiveCwd,
		gitGlobalOptions: globalResult.gitGlobalOptions,
		commitOptions,
		messageSource,
		cleanupOverride,
		isGeneratedMessage,
	};

	return { kind: "commit", invocation };
}

// ---------------------------------------------------------------------------
// cd analysis
// ---------------------------------------------------------------------------

function analyzeCd(argTokens: readonly ShellToken[], cwd: string): CommandResult {
	if (argTokens.length === 0) {
		// `cd` with no args goes to $HOME — dynamic
		return blocked(
			"cd without arguments is dynamic (depends on $HOME) and cannot be tracked statically",
			"dynamic-cd",
		);
	}

	const target = argTokens[0]!;

	if (target.value === "-") {
		return blocked(
			"cd - is dynamic (depends on OLDPWD) and cannot be tracked statically",
			"dynamic-cd",
		);
	}

	if (target.hasExpansion) {
		return blocked(
			"dynamic cd path: the cd target contains an unresolved expansion",
			"dynamic-cd",
		);
	}

	return { kind: "cd", newCwd: resolvePath(cwd, target.value) };
}

// ---------------------------------------------------------------------------
// Git global option parsing
// ---------------------------------------------------------------------------

interface GlobalOptionsResult {
	readonly kind: "ok";
	readonly gitGlobalOptions: GitGlobalOptions;
	readonly nextIdx: number;
}
type GlobalParseResult = GlobalOptionsResult | { readonly kind: "blocked"; readonly reason: string };

function parseGitGlobalOptions(
	tokens: readonly ShellToken[],
	startIdx: number,
	leadingAssignments: Map<string, string>,
	_cwd: string,
): GlobalParseResult {
	let idx = startIdx;
	const C: string[] = [];
	let gitDir: string | undefined;
	let workTree: string | undefined;
	let namespace: string | undefined;
	let execPath: string | undefined;
	let noPager = false;

	// Argument-free global switches (subset; extend as needed)
	const argFreeSwitches = new Set([
		"--no-pager",
		"--no-replace-objects",
		"--bare",
		"--literal-pathspecs",
		"--glob-pathspecs",
		"--noglob-pathspecs",
		"--icase-pathspecs",
		"--no-optional-locks",
		"--version",
		"--help",
		"-p",
		"--paginate",
	]);

	while (idx < tokens.length) {
		const tok = tokens[idx]!;

		if (tok.value === "--") {
			idx++;
			break;
		}

		// Expansion in a global option position blocks
		if (tok.hasExpansion) {
			return blocked(
				"expansion in git global option: cannot determine option structure",
				"expansion-in-subcommand",
			);
		}

		// Argument-free switches
		if (argFreeSwitches.has(tok.value)) {
			if (tok.value === "--no-pager") noPager = true;
			idx++;
			continue;
		}

		// -C
		if (tok.value === "-C") {
			idx++;
			if (idx >= tokens.length) return blocked("missing argument for git -C", "malformed-option");
			const val = tokens[idx]!;
			if (val.hasExpansion) return blocked("expansion in git -C path", "expansion-in-cwd");
			C.push(val.value);
			idx++;
			continue;
		}
		// -C attached: -C/some/path (rare but valid)
		if (tok.value.startsWith("-C") && tok.value.length > 2) {
			const path = tok.value.slice(2);
			C.push(path);
			idx++;
			continue;
		}

		// --git-dir
		if (tok.value === "--git-dir") {
			idx++;
			if (idx >= tokens.length) return blocked("missing argument for --git-dir", "malformed-option");
			const val = tokens[idx]!;
			if (val.hasExpansion) return blocked("expansion in --git-dir value", "expansion-in-path");
			gitDir = val.value;
			idx++;
			continue;
		}
		if (tok.value.startsWith("--git-dir=")) {
			gitDir = tok.value.slice("--git-dir=".length);
			idx++;
			continue;
		}

		// --work-tree
		if (tok.value === "--work-tree") {
			idx++;
			if (idx >= tokens.length) return blocked("missing argument for --work-tree", "malformed-option");
			const val = tokens[idx]!;
			if (val.hasExpansion) return blocked("expansion in --work-tree value", "expansion-in-path");
			workTree = val.value;
			idx++;
			continue;
		}
		if (tok.value.startsWith("--work-tree=")) {
			workTree = tok.value.slice("--work-tree=".length);
			idx++;
			continue;
		}

		// --namespace
		if (tok.value === "--namespace") {
			idx++;
			if (idx >= tokens.length) return blocked("missing argument for --namespace", "malformed-option");
			const val = tokens[idx]!;
			if (val.hasExpansion) return blocked("expansion in --namespace value", "expansion-in-cwd");
			namespace = val.value;
			idx++;
			continue;
		}
		if (tok.value.startsWith("--namespace=")) {
			namespace = tok.value.slice("--namespace=".length);
			idx++;
			continue;
		}

		// --exec-path
		if (tok.value === "--exec-path") {
			idx++;
			if (idx >= tokens.length) {
				// --exec-path with no argument just prints the exec path
				continue;
			}
			// If next token looks like an option or subcommand, don't consume
			if (tokens[idx]!.value.startsWith("-") || !tokens[idx]!.value.includes("/")) {
				// treat as no-arg form
				continue;
			}
			const val = tokens[idx]!;
			if (val.hasExpansion) return blocked("expansion in --exec-path value", "expansion-in-path");
			execPath = val.value;
			idx++;
			continue;
		}
		if (tok.value.startsWith("--exec-path=")) {
			execPath = tok.value.slice("--exec-path=".length);
			idx++;
			continue;
		}

		// -c config override: -c key=value
		if (tok.value === "-c") {
			idx++;
			if (idx >= tokens.length) return blocked("missing argument for git -c", "malformed-option");
			// Consume the config pair; we don't interpret it here
			idx++;
			continue;
		}
		if (tok.value.startsWith("-c") && tok.value.length > 2) {
			// -ckey=value attached form
			idx++;
			continue;
		}

		// If we see something that looks like an unknown global option starting
		// with -, and it's before a known subcommand, block to be safe.
		if (tok.value.startsWith("-")) {
			// Could be a subcommand option that leaked here — stop consuming globals.
			break;
		}

		// Non-option: must be the subcommand
		break;
	}

	const gitGlobalOptions: GitGlobalOptions = {
		C,
		gitDir,
		workTree,
		namespace,
		execPath,
		noPager,
		leadingAssignments: new Map(leadingAssignments),
	};

	return { kind: "ok", gitGlobalOptions, nextIdx: idx };
}

// ---------------------------------------------------------------------------
// Commit option parsing
// ---------------------------------------------------------------------------

interface CommitParseOk {
	readonly kind: "ok";
	readonly commitOptions: CommitOptions;
	readonly messageSource: MessageSource;
	readonly cleanupOverride: CleanupMode | undefined;
	readonly isGeneratedMessage: boolean;
}
type CommitParseResult = CommitParseOk | { readonly kind: "blocked"; readonly reason: string };

// Static lookup tables used inside parseCommitOptions — hoisted to avoid per-iteration allocation.
const COMMIT_TOLERATED_FLAGS: Record<string, true> = {
	"--all": true, "-a": true,
	"--patch": true, "-p": true,
	"--reuse-message": true,
	"--reset-author": true,
	"--short": true,
	"--branch": true,
	"--porcelain": true,
	"--long": true,
	"--null": true, "-z": true,
	"--signoff": true, "-s": true,
	"--no-verify": true, "-n": true,
	"--allow-empty": true,
	"--only": true, "-o": true,
	"--include": true, "-i": true,
	"--interactive": true,
	"--dry-run": true,
	"--status": true,
	"--no-status": true,
	"--gpg-sign": true, "-S": true,
	"--no-gpg-sign": true,
	"--verbose": true, "-v": true,
	"--untracked-files": true,
	"--pathspec-from-file": true,
	"--pathspec-file-nul": true,
	"--trailer": true,
	"--date": true,
};

// Tolerated options that consume the following token as their argument.
const COMMIT_TOLERATED_WITH_ARG: Record<string, true> = {
	"--author": true,
	"--date": true,
	"-S": true, "--gpg-sign": true,
	"--trailer": true,
	"--untracked-files": true,
	"--pathspec-from-file": true,
};

// Tolerated long-option prefixes for the --opt=value attached form.
const COMMIT_TOLERATED_LONG_PREFIXES: readonly string[] = [
	"--author=",
	"--date=",
	"--gpg-sign=",
	"--trailer=",
	"--untracked-files=",
	"--pathspec-from-file=",
];

// Short option characters that carry no argument and are safe to cluster.
const CLUSTER_TOLERATED_SHORT: Record<string, true> = {
	a: true, p: true, s: true, n: true, o: true, i: true, v: true, z: true, S: true,
};

// Short option characters that take a value argument (used in cluster detection).
const CLUSTER_VALUE_FLAGS: Record<string, true> = {
	m: true, F: true, C: true, c: true,
};

function parseCommitOptions(tokens: readonly ShellToken[], startIdx: number): CommitParseResult {
	let idx = startIdx;

	// Message source fields — we allow multiple -m paragraphs but block other combinations.
	const mParagraphs: string[] = [];
	let fileSource: string | undefined;
	let reuseRevision: string | undefined;
	let reeditRevision: string | undefined;

	let amend = false;
	let noEdit = false;
	let fixup: string | undefined;
	let squash: string | undefined;
	let allowEmptyMessage = false;
	let cleanupOverride: CleanupMode | undefined;

	// Track source kinds found so far for conflict detection
	type SourceKind = "m" | "file" | "reuse" | "reedit";
	const sourcesFound: SourceKind[] = [];

	const endOfOptions = false;

	while (idx < tokens.length) {
		const tok = tokens[idx]!;
		const val = tok.value;

		if (!endOfOptions && val === "--") {
			idx++;
			// Everything after -- is pathspecs; skip them (no message sources there)
			break;
		}

		// Non-option: positional argument (pathspec) — skip
		if (!val.startsWith("-") || endOfOptions) {
			idx++;
			continue;
		}

		// -m and variants
		// Attached: -mVALUE
		if (!tok.hasExpansion && val.startsWith("-m") && val.length > 2) {
			const msg = val.slice(2);
			if (tok.hasExpansion) {
				return blocked("expansion in -m message value", "expansion-in-message");
			}
			mParagraphs.push(msg);
			sourcesFound.push("m");
			idx++;
			continue;
		}
		// Separate: -m VALUE
		if (!tok.hasExpansion && val === "-m") {
			idx++;
			if (idx >= tokens.length) return blocked("missing argument for -m", "malformed-option");
			const msgTok = tokens[idx]!;
			if (msgTok.hasExpansion) return blocked("expansion in -m message value", "expansion-in-message");
			mParagraphs.push(msgTok.value);
			sourcesFound.push("m");
			idx++;
			continue;
		}
		// --message=VALUE
		if (!tok.hasExpansion && val.startsWith("--message=")) {
			const msg = val.slice("--message=".length);
			mParagraphs.push(msg);
			sourcesFound.push("m");
			idx++;
			continue;
		}
		// --message VALUE
		if (!tok.hasExpansion && val === "--message") {
			idx++;
			if (idx >= tokens.length) return blocked("missing argument for --message", "malformed-option");
			const msgTok = tokens[idx]!;
			if (msgTok.hasExpansion) return blocked("expansion in --message value", "expansion-in-message");
			mParagraphs.push(msgTok.value);
			sourcesFound.push("m");
			idx++;
			continue;
		}

		// -F and variants
		if (!tok.hasExpansion && val.startsWith("-F") && val.length > 2) {
			fileSource = val.slice(2);
			sourcesFound.push("file");
			idx++;
			continue;
		}
		if (!tok.hasExpansion && val === "-F") {
			idx++;
			if (idx >= tokens.length) return blocked("missing argument for -F", "malformed-option");
			const fTok = tokens[idx]!;
			if (fTok.hasExpansion) return blocked("expansion in -F path", "expansion-in-path");
			fileSource = fTok.value;
			sourcesFound.push("file");
			idx++;
			continue;
		}
		if (!tok.hasExpansion && val.startsWith("--file=")) {
			fileSource = val.slice("--file=".length);
			sourcesFound.push("file");
			idx++;
			continue;
		}
		if (!tok.hasExpansion && val === "--file") {
			idx++;
			if (idx >= tokens.length) return blocked("missing argument for --file", "malformed-option");
			const fTok = tokens[idx]!;
			if (fTok.hasExpansion) return blocked("expansion in --file path", "expansion-in-path");
			fileSource = fTok.value;
			sourcesFound.push("file");
			idx++;
			continue;
		}

		// -C and variants (--reuse-message)
		if (!tok.hasExpansion && val.startsWith("-C") && val.length > 2) {
			// NB: -C is also a git global option, but here we are past the subcommand
			reuseRevision = val.slice(2);
			sourcesFound.push("reuse");
			idx++;
			continue;
		}
		if (!tok.hasExpansion && val === "-C") {
			idx++;
			if (idx >= tokens.length) return blocked("missing argument for -C", "malformed-option");
			const rTok = tokens[idx]!;
			if (rTok.hasExpansion) return blocked("expansion in -C revision", "expansion-in-revision");
			reuseRevision = rTok.value;
			sourcesFound.push("reuse");
			idx++;
			continue;
		}
		if (!tok.hasExpansion && val.startsWith("--reuse-message=")) {
			reuseRevision = val.slice("--reuse-message=".length);
			sourcesFound.push("reuse");
			idx++;
			continue;
		}
		if (!tok.hasExpansion && val === "--reuse-message") {
			idx++;
			if (idx >= tokens.length) return blocked("missing argument for --reuse-message", "malformed-option");
			const rTok = tokens[idx]!;
			if (rTok.hasExpansion) return blocked("expansion in --reuse-message revision", "expansion-in-revision");
			reuseRevision = rTok.value;
			sourcesFound.push("reuse");
			idx++;
			continue;
		}

		// -c and variants (--reedit-message)
		if (!tok.hasExpansion && val.startsWith("-c") && val.length > 2) {
			reeditRevision = val.slice(2);
			sourcesFound.push("reedit");
			idx++;
			continue;
		}
		if (!tok.hasExpansion && val === "-c") {
			idx++;
			if (idx >= tokens.length) return blocked("missing argument for -c", "malformed-option");
			const rTok = tokens[idx]!;
			if (rTok.hasExpansion) return blocked("expansion in -c revision", "expansion-in-revision");
			reeditRevision = rTok.value;
			sourcesFound.push("reedit");
			idx++;
			continue;
		}
		if (!tok.hasExpansion && val.startsWith("--reedit-message=")) {
			reeditRevision = val.slice("--reedit-message=".length);
			sourcesFound.push("reedit");
			idx++;
			continue;
		}
		if (!tok.hasExpansion && val === "--reedit-message") {
			idx++;
			if (idx >= tokens.length) return blocked("missing argument for --reedit-message", "malformed-option");
			const rTok = tokens[idx]!;
			if (rTok.hasExpansion) return blocked("expansion in --reedit-message revision", "expansion-in-revision");
			reeditRevision = rTok.value;
			sourcesFound.push("reedit");
			idx++;
			continue;
		}

		// --cleanup
		if (!tok.hasExpansion && val.startsWith("--cleanup=")) {
			const mode = val.slice("--cleanup=".length);
			const r = validateCleanupMode(mode);
			if (r === null) return blocked(`unknown --cleanup mode: ${mode}`, "malformed-option");
			cleanupOverride = r;
			idx++;
			continue;
		}
		if (!tok.hasExpansion && val === "--cleanup") {
			idx++;
			if (idx >= tokens.length) return blocked("missing argument for --cleanup", "malformed-option");
			const mTok = tokens[idx]!;
			if (mTok.hasExpansion) return blocked("expansion in --cleanup value", "expansion-in-cleanup");
			const r = validateCleanupMode(mTok.value);
			if (r === null) return blocked(`unknown --cleanup mode: ${mTok.value}`, "malformed-option");
			cleanupOverride = r;
			idx++;
			continue;
		}

		// --amend
		if (!tok.hasExpansion && val === "--amend") {
			amend = true;
			idx++;
			continue;
		}

		// --no-edit
		if (!tok.hasExpansion && val === "--no-edit") {
			noEdit = true;
			idx++;
			continue;
		}

		// --fixup=<commit>
		if (!tok.hasExpansion && val.startsWith("--fixup=")) {
			fixup = val.slice("--fixup=".length);
			idx++;
			continue;
		}
		if (!tok.hasExpansion && val === "--fixup") {
			idx++;
			if (idx >= tokens.length) return blocked("missing argument for --fixup", "malformed-option");
			const fTok = tokens[idx]!;
			if (fTok.hasExpansion) return blocked("expansion in --fixup commit", "expansion-in-revision");
			fixup = fTok.value;
			idx++;
			continue;
		}

		// --squash=<commit>
		if (!tok.hasExpansion && val.startsWith("--squash=")) {
			squash = val.slice("--squash=".length);
			idx++;
			continue;
		}
		if (!tok.hasExpansion && val === "--squash") {
			idx++;
			if (idx >= tokens.length) return blocked("missing argument for --squash", "malformed-option");
			const sTok = tokens[idx]!;
			if (sTok.hasExpansion) return blocked("expansion in --squash commit", "expansion-in-revision");
			squash = sTok.value;
			idx++;
			continue;
		}

		// --allow-empty-message
		if (!tok.hasExpansion && val === "--allow-empty-message") {
			allowEmptyMessage = true;
			idx++;
			continue;
		}

		// Other flags that don't affect message source — tolerate common ones
		if (!tok.hasExpansion && COMMIT_TOLERATED_FLAGS[val]) {
			idx++;
			continue;
		}
		// Options that take a separate argument among tolerated set
		if (!tok.hasExpansion && COMMIT_TOLERATED_WITH_ARG[val]) {
			idx += 2; // skip the flag and its argument
			continue;
		}

		// Equals-attached forms of tolerated long options with values.
		// e.g. --author=Name, --date=2024-01-01, --gpg-sign=KEY, --trailer=X:Y,
		//      --untracked-files=all, --pathspec-from-file=file
		if (!tok.hasExpansion && val.startsWith("--")) {
			if (COMMIT_TOLERATED_LONG_PREFIXES.some((pfx) => val.startsWith(pfx))) {
				idx++;
				continue;
			}
		}

		// Attached forms of tolerated short flags (e.g. -S<key-id>)
		if (!tok.hasExpansion && val.startsWith("-S") && val.length > 2) {
			idx++;
			continue;
		}

		// Clustered short flags: e.g. -am 'msg', -amMyMessage, -aF file, -aC HEAD.
		// Scan chars after '-'; all chars before the terminal value-flag must be
		// tolerated no-arg flags.  The terminal is the first m/F/C/c found, or, if
		// none, the last char (all-no-arg cluster).
		if (!tok.hasExpansion && val.startsWith("-") && !val.startsWith("--") && val.length > 2) {
			const chars = val.slice(1);
			// Find the first value-taking flag in the cluster
			const terminalIdx = [...chars].findIndex((c) => CLUSTER_VALUE_FLAGS[c]);

			if (terminalIdx === -1) {
				// Pure no-arg cluster: all chars must be tolerated
				if ([...chars].every((c) => CLUSTER_TOLERATED_SHORT[c])) {
					idx++;
					continue;
				}
				// Unknown chars in cluster — fall through to unknown-option handling
			} else {
				// All chars before terminalIdx must be tolerated no-arg flags
				const prefix = chars.slice(0, terminalIdx);
				const allPrefixTolerated = [...prefix].every((c) => CLUSTER_TOLERATED_SHORT[c]);

				if (allPrefixTolerated) {
					const terminal = chars[terminalIdx]!;
					// Value may be attached (chars after the terminal) or in the next token
					const attached = chars.slice(terminalIdx + 1);

					if (terminal === "m") {
						if (attached.length > 0) {
							mParagraphs.push(attached);
							sourcesFound.push("m");
							idx++;
							continue;
						}
						idx++;
						if (idx >= tokens.length) return blocked("missing argument for -m in clustered flag", "malformed-option");
						const msgTok = tokens[idx]!;
						if (msgTok.hasExpansion) return blocked("expansion in -m message value", "expansion-in-message");
						mParagraphs.push(msgTok.value);
						sourcesFound.push("m");
						idx++;
						continue;
					}
					if (terminal === "F") {
						if (attached.length > 0) {
							fileSource = attached;
							sourcesFound.push("file");
							idx++;
							continue;
						}
						idx++;
						if (idx >= tokens.length) return blocked("missing argument for -F in clustered flag", "malformed-option");
						const fTok = tokens[idx]!;
						if (fTok.hasExpansion) return blocked("expansion in -F path", "expansion-in-path");
						fileSource = fTok.value;
						sourcesFound.push("file");
						idx++;
						continue;
					}
					if (terminal === "C") {
						if (attached.length > 0) {
							reuseRevision = attached;
							sourcesFound.push("reuse");
							idx++;
							continue;
						}
						idx++;
						if (idx >= tokens.length) return blocked("missing argument for -C in clustered flag", "malformed-option");
						const rTok = tokens[idx]!;
						if (rTok.hasExpansion) return blocked("expansion in -C revision", "expansion-in-revision");
						reuseRevision = rTok.value;
						sourcesFound.push("reuse");
						idx++;
						continue;
					}
					if (terminal === "c") {
						if (attached.length > 0) {
							reeditRevision = attached;
							sourcesFound.push("reedit");
							idx++;
							continue;
						}
						idx++;
						if (idx >= tokens.length) return blocked("missing argument for -c in clustered flag", "malformed-option");
						const rTok = tokens[idx]!;
						if (rTok.hasExpansion) return blocked("expansion in -c revision", "expansion-in-revision");
						reeditRevision = rTok.value;
						sourcesFound.push("reedit");
						idx++;
						continue;
					}
				}
				// prefix not all tolerated — fall through to unknown-option handling
			}
		}

		// Expansion in an option position where we can't parse the option
		if (tok.hasExpansion) {
			return blocked(
				"expansion in commit option: option structure cannot be statically determined",
				"expansion-in-message",
			);
		}

		// Unknown option
		if (val.startsWith("-")) {
			// Unknown long options always block.
			if (val.startsWith("--")) {
				return blocked(
					`unknown git commit option: ${val}`,
					"unknown-commit-option",
				);
			}
			// Unknown short flags — skip (may be tolerated flags we haven't listed)
			idx++;
			continue;
		}

		// Positional — pathspec, skip
		idx++;
	}

	// Check for conflicting message sources
	// Collect distinct source kinds (m counts once regardless of repetition)
	const distinctSources = [...new Set(sourcesFound)];
	if (distinctSources.length > 1) {
		return blocked(
			`conflicting message sources: ${distinctSources.join(", ")} specified together`,
			"conflicting-message-source",
		);
	}

	// Determine generated/no-edit flag
	const isGeneratedMessage = fixup !== undefined || squash !== undefined;

	// --amend --no-edit → amend-no-edit message source
	if (amend && noEdit) {
		const commitOptions: CommitOptions = { amend, noEdit, fixup, squash, allowEmptyMessage };
		return {
			kind: "ok",
			commitOptions,
			messageSource: { kind: "amend-no-edit" },
			cleanupOverride,
			isGeneratedMessage: true,
		};
	}

	// fixup or squash → generated message
	if (isGeneratedMessage) {
		const commitOptions: CommitOptions = { amend, noEdit, fixup, squash, allowEmptyMessage };
		return {
			kind: "ok",
			commitOptions,
			messageSource: { kind: "generated" },
			cleanupOverride,
			isGeneratedMessage: true,
		};
	}

	// Determine message source
	let messageSource: MessageSource;

	if (mParagraphs.length > 0) {
		messageSource = { kind: "inline", paragraphs: mParagraphs };
	} else if (fileSource !== undefined) {
		if (fileSource === "-" || fileSource === "/dev/stdin") {
			return blocked(
				"stdin file source (-F - or -F /dev/stdin) is not statically resolvable",
				"heredoc-input",
			);
		}
		messageSource = { kind: "file", path: fileSource };
	} else if (reuseRevision !== undefined) {
		messageSource = { kind: "reuse-commit", revision: reuseRevision };
	} else if (reeditRevision !== undefined) {
		messageSource = { kind: "reedit-commit", revision: reeditRevision };
	} else {
		// No message source specified — editor-bound
		messageSource = { kind: "editor-bound" };
	}

	const commitOptions: CommitOptions = { amend, noEdit, fixup, squash, allowEmptyMessage };
	return {
		kind: "ok",
		commitOptions,
		messageSource,
		cleanupOverride,
		isGeneratedMessage: false,
	};
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function blocked(reason: string, _code: CommitBlockedCode): { readonly kind: "blocked"; readonly reason: string } {
	return { kind: "blocked", reason };
}

function validateCleanupMode(mode: string): CleanupMode | null {
	const valid = new Set<CleanupMode>(["strip", "whitespace", "verbatim", "scissors", "default"]);
	return valid.has(mode as CleanupMode) ? (mode as CleanupMode) : null;
}

/**
 * Resolve a path segment against a base directory.
 * Only supports absolute paths and simple relative paths — no symlink resolution.
 */
function resolvePath(base: string, target: string): string {
	if (target.startsWith("/")) return target;
	// Join and normalize
	const parts = (base + "/" + target).split("/").filter(Boolean);
	const resolved: string[] = [];
	for (const part of parts) {
		if (part === "..") {
			resolved.pop();
		} else if (part !== ".") {
			resolved.push(part);
		}
	}
	return "/" + resolved.join("/");
}

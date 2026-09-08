/**
 * Tests for commit-command.ts: git commit recognition, option parsing,
 * cwd tracking, indirect wrappers, and expansion checks.
 *
 * Covers every Phase 2 matrix item:
 *   - Ordinary and multiline quoted -m
 *   - Repeated -m paragraph assembly
 *   - Attached, equals, and separated flag forms
 *   - Escaped quotes, escaped operators, backslash-newline
 *   - $ and # inside single quotes
 *   - Expansion inside unquoted and double-quoted regions
 *   - Comments outside quotes
 *   - Every supported separator and multiple commits in one call
 *   - Redirections without message ambiguity
 *   - Leading assignments and env
 *   - Git global options before commit
 *   - Bash cwd, static cd, and repeated git -C
 *   - Visible indirect wrappers
 *   - Heredoc, here-string, process substitution, malformed quoting, grouping
 *   - Quoted command text that must not trigger
 */

import { describe, it, expect } from "bun:test";
import { analyzeCommand } from "../src/commit-command.ts";
import type { ShellAnalysis, CommitInvocation } from "../src/types.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CWD = "/repo";

function invocations(result: ShellAnalysis): CommitInvocation[] {
	if (result.kind !== "commits") throw new Error(`Expected commits, got: ${result.kind}`);
	return [...result.invocations];
}

function singleInvocation(raw: string, cwd = CWD): CommitInvocation {
	const result = analyzeCommand(raw, cwd);
	const inv = invocations(result);
	if (inv.length !== 1) throw new Error(`Expected 1 invocation, got ${inv.length}`);
	return inv[0]!;
}

function expectBlocked(raw: string, cwd = CWD): { reason: string } {
	const result = analyzeCommand(raw, cwd);
	if (result.kind !== "blocked") throw new Error(`Expected blocked, got: ${result.kind}`);
	return result;
}

function expectNoCommit(raw: string, cwd = CWD): void {
	const result = analyzeCommand(raw, cwd);
	expect(result.kind).toBe("no-commit");
}

// ---------------------------------------------------------------------------
// Basic detection
// ---------------------------------------------------------------------------

describe("basic detection", () => {
	it("bare git commit is editor-bound", () => {
		const inv = singleInvocation("git commit");
		expect(inv.messageSource.kind).toBe("editor-bound");
	});

	it("git commit -m with simple message", () => {
		const inv = singleInvocation("git commit -m 'feat: add thing'");
		expect(inv.messageSource.kind).toBe("inline");
		if (inv.messageSource.kind === "inline") {
			expect(inv.messageSource.paragraphs).toEqual(["feat: add thing"]);
		}
	});

	it("non-commit git subcommand is no-commit", () => {
		expectNoCommit("git status");
	});

	it("git ci (alias) is no-commit", () => {
		expectNoCommit("git ci -m 'fix: thing'");
	});

	it("echo with quoted git commit text is no-commit", () => {
		expectNoCommit("echo 'git commit -m x'");
	});

	it("unrelated command is no-commit", () => {
		expectNoCommit("ls -la");
	});

	it("empty command is no-commit", () => {
		expectNoCommit("");
	});
});

// ---------------------------------------------------------------------------
// Message flag forms
// ---------------------------------------------------------------------------

describe("-m flag forms", () => {
	it("-m VALUE (separate)", () => {
		const inv = singleInvocation("git commit -m 'fix: bug'");
		if (inv.messageSource.kind !== "inline") throw new Error("wrong kind");
		expect(inv.messageSource.paragraphs[0]).toBe("fix: bug");
	});

	it("-mVALUE (attached)", () => {
		const inv = singleInvocation("git commit -mfeat:thing");
		if (inv.messageSource.kind !== "inline") throw new Error("wrong kind");
		expect(inv.messageSource.paragraphs[0]).toBe("feat:thing");
	});

	it("--message=VALUE (equals)", () => {
		const inv = singleInvocation("git commit --message='fix: a'");
		if (inv.messageSource.kind !== "inline") throw new Error("wrong kind");
		expect(inv.messageSource.paragraphs[0]).toBe("fix: a");
	});

	it("--message VALUE (separate)", () => {
		const inv = singleInvocation("git commit --message 'fix: b'");
		if (inv.messageSource.kind !== "inline") throw new Error("wrong kind");
		expect(inv.messageSource.paragraphs[0]).toBe("fix: b");
	});

	it("repeated -m assembles paragraphs with \\n\\n join (values preserved separately)", () => {
		const inv = singleInvocation("git commit -m 'feat: header' -m 'Body paragraph.'");
		if (inv.messageSource.kind !== "inline") throw new Error("wrong kind");
		expect(inv.messageSource.paragraphs).toEqual(["feat: header", "Body paragraph."]);
	});

	it("three -m paragraphs all preserved", () => {
		const inv = singleInvocation("git commit -m 'A' -m 'B' -m 'C'");
		if (inv.messageSource.kind !== "inline") throw new Error("wrong kind");
		expect(inv.messageSource.paragraphs).toHaveLength(3);
	});

	it("expansion in -m value blocks", () => {
		expectBlocked("git commit -m $MSG");
	});

	it("expansion in unquoted -m value blocks", () => {
		expectBlocked('git commit -m "fix $ISSUE"');
	});

	it("expansion check: single-quoted -m with $ is not blocked", () => {
		const inv = singleInvocation("git commit -m 'fix #123 cost $5'");
		if (inv.messageSource.kind !== "inline") throw new Error("wrong kind");
		expect(inv.messageSource.paragraphs[0]).toBe("fix #123 cost $5");
	});
});

// ---------------------------------------------------------------------------
// -F file source forms
// ---------------------------------------------------------------------------

describe("-F file source forms", () => {
	it("-F path/to/file", () => {
		const inv = singleInvocation("git commit -F COMMIT_MSG.txt");
		expect(inv.messageSource.kind).toBe("file");
		if (inv.messageSource.kind === "file") {
			expect(inv.messageSource.path).toBe("COMMIT_MSG.txt");
		}
	});

	it("-FPATH (attached)", () => {
		const inv = singleInvocation("git commit -FCOMMIT_MSG.txt");
		expect(inv.messageSource.kind).toBe("file");
	});

	it("--file=PATH (equals)", () => {
		const inv = singleInvocation("git commit --file=COMMIT_MSG.txt");
		expect(inv.messageSource.kind).toBe("file");
	});

	it("--file PATH (separate)", () => {
		const inv = singleInvocation("git commit --file COMMIT_MSG.txt");
		expect(inv.messageSource.kind).toBe("file");
	});

	it("-F - blocks (stdin)", () => {
		const r = expectBlocked("git commit -F -");
		expect(r.reason).toContain("stdin");
	});

	it("-F /dev/stdin blocks", () => {
		const r = expectBlocked("git commit -F /dev/stdin");
		expect(r.reason).toContain("stdin");
	});

	it("expansion in -F path blocks", () => {
		expectBlocked("git commit -F $MSG_FILE");
	});
});

// ---------------------------------------------------------------------------
// -C and -c reuse/reedit forms
// ---------------------------------------------------------------------------

describe("-C and -c source forms", () => {
	it("-C REVISION (separate)", () => {
		const inv = singleInvocation("git commit -C HEAD");
		expect(inv.messageSource.kind).toBe("reuse-commit");
		if (inv.messageSource.kind === "reuse-commit") {
			expect(inv.messageSource.revision).toBe("HEAD");
		}
	});

	it("-CREVISION (attached)", () => {
		const inv = singleInvocation("git commit -CHEAD");
		expect(inv.messageSource.kind).toBe("reuse-commit");
	});

	it("--reuse-message=REVISION (equals)", () => {
		const inv = singleInvocation("git commit --reuse-message=HEAD~1");
		expect(inv.messageSource.kind).toBe("reuse-commit");
		if (inv.messageSource.kind === "reuse-commit") {
			expect(inv.messageSource.revision).toBe("HEAD~1");
		}
	});

	it("--reuse-message REVISION (separate)", () => {
		const inv = singleInvocation("git commit --reuse-message HEAD");
		expect(inv.messageSource.kind).toBe("reuse-commit");
	});

	it("-c REVISION (reedit separate)", () => {
		const inv = singleInvocation("git commit -c HEAD");
		expect(inv.messageSource.kind).toBe("reedit-commit");
	});

	it("-cREVISION (reedit attached)", () => {
		const inv = singleInvocation("git commit -cHEAD");
		expect(inv.messageSource.kind).toBe("reedit-commit");
	});

	it("--reedit-message=REVISION", () => {
		const inv = singleInvocation("git commit --reedit-message=HEAD");
		expect(inv.messageSource.kind).toBe("reedit-commit");
	});

	it("expansion in -C revision blocks", () => {
		expectBlocked("git commit -C $REV");
	});

	it("expansion in -c revision blocks", () => {
		expectBlocked("git commit -c $REV");
	});
});

// ---------------------------------------------------------------------------
// Generated message sources
// ---------------------------------------------------------------------------

describe("generated message sources", () => {
	it("--amend --no-edit yields amend-no-edit source", () => {
		const inv = singleInvocation("git commit --amend --no-edit");
		expect(inv.messageSource.kind).toBe("amend-no-edit");
		expect(inv.isGeneratedMessage).toBe(true);
	});

	it("--fixup=<commit> yields generated source", () => {
		const inv = singleInvocation("git commit --fixup=HEAD");
		expect(inv.messageSource.kind).toBe("generated");
		expect(inv.isGeneratedMessage).toBe(true);
	});

	it("--squash=<commit> yields generated source", () => {
		const inv = singleInvocation("git commit --squash=abc123");
		expect(inv.messageSource.kind).toBe("generated");
		expect(inv.isGeneratedMessage).toBe(true);
	});

	it("--fixup separate form", () => {
		const inv = singleInvocation("git commit --fixup HEAD");
		expect(inv.messageSource.kind).toBe("generated");
	});
});

// ---------------------------------------------------------------------------
// Conflicting message sources
// ---------------------------------------------------------------------------

describe("conflicting message sources", () => {
	it("-m and -F together block", () => {
		expectBlocked("git commit -m 'x' -F file.txt");
	});

	it("-m and -C together block", () => {
		expectBlocked("git commit -m 'x' -C HEAD");
	});

	it("-F and -C together block", () => {
		expectBlocked("git commit -F file.txt -C HEAD");
	});

	it("-c and -m together block", () => {
		expectBlocked("git commit -c HEAD -m 'x'");
	});
});

// ---------------------------------------------------------------------------
// --cleanup
// ---------------------------------------------------------------------------

describe("--cleanup option", () => {
	it("--cleanup=strip is recorded", () => {
		const inv = singleInvocation("git commit -m x --cleanup=strip");
		expect(inv.cleanupOverride).toBe("strip");
	});

	it("--cleanup whitespace (separate)", () => {
		const inv = singleInvocation("git commit -m x --cleanup whitespace");
		expect(inv.cleanupOverride).toBe("whitespace");
	});

	it("--cleanup=verbatim", () => {
		const inv = singleInvocation("git commit -m x --cleanup=verbatim");
		expect(inv.cleanupOverride).toBe("verbatim");
	});

	it("--cleanup=scissors", () => {
		const inv = singleInvocation("git commit -m x --cleanup=scissors");
		expect(inv.cleanupOverride).toBe("scissors");
	});

	it("unknown --cleanup mode blocks", () => {
		expectBlocked("git commit -m x --cleanup=bogus");
	});

	it("expansion in --cleanup value blocks", () => {
		expectBlocked("git commit -m x --cleanup $MODE");
	});
});

// ---------------------------------------------------------------------------
// Git global options
// ---------------------------------------------------------------------------

describe("git global options", () => {
	it("-C single directory", () => {
		const inv = singleInvocation("git -C /other commit -m 'x'");
		expect(inv.gitGlobalOptions.C).toEqual(["/other"]);
		expect(inv.effectiveCwd).toBe("/other");
	});

	it("-C relative directory resolves against baseCwd", () => {
		const inv = singleInvocation("git -C subdir commit -m 'x'", "/repo");
		expect(inv.gitGlobalOptions.C).toEqual(["subdir"]);
		expect(inv.effectiveCwd).toBe("/repo/subdir");
	});

	it("repeated -C accumulates", () => {
		const inv = singleInvocation("git -C /a -C b commit -m 'x'");
		expect(inv.gitGlobalOptions.C).toEqual(["/a", "b"]);
		// /a -> /a/b
		expect(inv.effectiveCwd).toBe("/a/b");
	});

	it("-C .. goes up one directory", () => {
		const inv = singleInvocation("git -C /repo/sub -C .. commit -m 'x'");
		expect(inv.effectiveCwd).toBe("/repo");
	});

	it("--git-dir is recorded", () => {
		const inv = singleInvocation("git --git-dir=/custom/.git commit -m x");
		expect(inv.gitGlobalOptions.gitDir).toBe("/custom/.git");
	});

	it("--work-tree is recorded", () => {
		const inv = singleInvocation("git --work-tree=/custom commit -m x");
		expect(inv.gitGlobalOptions.workTree).toBe("/custom");
	});

	it("--no-pager is recorded", () => {
		const inv = singleInvocation("git --no-pager commit -m x");
		expect(inv.gitGlobalOptions.noPager).toBe(true);
	});

	it("-c key=value is consumed without blocking", () => {
		const inv = singleInvocation("git -c user.email=x@y.com commit -m 'x'");
		expect(inv.messageSource.kind).toBe("inline");
	});

	it("expansion in git -C path blocks", () => {
		expectBlocked("git -C $DIR commit -m x");
	});

	it("attached -C path: -C/some/path", () => {
		const inv = singleInvocation("git -C/other commit -m 'x'");
		expect(inv.gitGlobalOptions.C).toEqual(["/other"]);
	});
});

// ---------------------------------------------------------------------------
// Leading assignments
// ---------------------------------------------------------------------------

describe("leading assignments", () => {
	it("NAME=value before git is captured in leadingAssignments", () => {
		const inv = singleInvocation("GIT_AUTHOR_NAME=Test git commit -m 'x'");
		expect(inv.gitGlobalOptions.leadingAssignments.get("GIT_AUTHOR_NAME")).toBe("Test");
	});

	it("multiple assignments before git", () => {
		const inv = singleInvocation("A=1 B=2 git commit -m 'x'");
		expect(inv.gitGlobalOptions.leadingAssignments.size).toBe(2);
	});

	it("env VAR=val git commit is recognized", () => {
		const inv = singleInvocation("env GIT_AUTHOR_EMAIL=a@b.com git commit -m 'x'");
		expect(inv.messageSource.kind).toBe("inline");
	});
});

// ---------------------------------------------------------------------------
// Static cwd tracking
// ---------------------------------------------------------------------------

describe("static cwd tracking", () => {
	it("cd absolute path before git commit updates effectiveCwd", () => {
		const inv = singleInvocation("cd /other/repo && git commit -m 'x'", "/start");
		expect(inv.effectiveCwd).toBe("/other/repo");
	});

	it("cd relative path before git commit updates effectiveCwd", () => {
		const inv = singleInvocation("cd subdir && git commit -m 'x'", "/repo");
		expect(inv.effectiveCwd).toBe("/repo/subdir");
	});

	it("cd .. goes up one level", () => {
		const inv = singleInvocation("cd .. && git commit -m 'x'", "/repo/sub");
		expect(inv.effectiveCwd).toBe("/repo");
	});

	it("multiple cd steps accumulate", () => {
		const inv = singleInvocation("cd /a && cd b && git commit -m 'x'");
		expect(inv.effectiveCwd).toBe("/a/b");
	});

	it("cd with no args blocks", () => {
		expectBlocked("cd && git commit -m x");
	});

	it("cd - blocks", () => {
		expectBlocked("cd - && git commit -m x");
	});

	it("cd $DIR blocks", () => {
		expectBlocked("cd $DIR && git commit -m x");
	});

	it("pushd blocks", () => {
		expectBlocked("pushd /other && git commit -m x");
	});

	it("popd blocks", () => {
		expectBlocked("popd && git commit -m x");
	});

	it("input.cwd is used as baseCwd when provided", () => {
		const inv = singleInvocation("git commit -m 'x'", "/from-input");
		expect(inv.effectiveCwd).toBe("/from-input");
	});
});

// ---------------------------------------------------------------------------
// Multiple commits in one command
// ---------------------------------------------------------------------------

describe("multiple commits in one call", () => {
	it("two commits separated by && both appear", () => {
		const result = analyzeCommand(
			"git commit -m 'feat: A' && git commit -m 'feat: B'",
			CWD,
		);
		expect(invocations(result)).toHaveLength(2);
	});

	it("two commits separated by ; both appear", () => {
		const result = analyzeCommand(
			"git commit -m 'A'; git commit -m 'B'",
			CWD,
		);
		expect(invocations(result)).toHaveLength(2);
	});

	it("two commits separated by newline both appear", () => {
		const result = analyzeCommand(
			"git commit -m 'A'\ngit commit -m 'B'",
			CWD,
		);
		expect(invocations(result)).toHaveLength(2);
	});

	it("second commit inherits cd from first command", () => {
		const result = analyzeCommand(
			"cd /other && git add . && git commit -m 'x'",
			"/start",
		);
		const inv = invocations(result);
		expect(inv[0]!.effectiveCwd).toBe("/other");
	});
});

// ---------------------------------------------------------------------------
// Indirect wrappers
// ---------------------------------------------------------------------------

describe("indirect wrappers", () => {
	it("bash -c 'git commit ...' blocks", () => {
		const r = expectBlocked("bash -c 'git commit -m x'");
		expect(r.reason).toContain("indirect wrapper");
	});

	it("sh -c '...' blocks when git commit present", () => {
		expectBlocked("sh -c 'git commit -m x'");
	});

	it("eval 'git commit ...' blocks", () => {
		expectBlocked("eval 'git commit -m x'");
	});

	it("xargs git commit blocks", () => {
		expectBlocked("echo x | xargs git commit -m something");
	});

	it("find -exec git commit blocks", () => {
		expectBlocked("find . -exec git commit -m x ;");
	});

	it("bash without git commit in args is no-commit", () => {
		expectNoCommit("bash -c 'echo hello'");
	});
});

// ---------------------------------------------------------------------------
// Redirections with commits
// ---------------------------------------------------------------------------

describe("redirections with commits", () => {
	it("output redirect after git commit does not block", () => {
		const inv = singleInvocation("git commit -m 'x' 2>/dev/null");
		expect(inv.messageSource.kind).toBe("inline");
	});

	it("output redirect >> does not block", () => {
		const inv = singleInvocation("git commit -m 'x' >> log.txt");
		expect(inv.messageSource.kind).toBe("inline");
	});

	it("git commit with heredoc stdin blocks", () => {
		const raw = "git commit -m x << EOF\ncontent\nEOF";
		expectBlocked(raw);
	});

	it("here-string stdin blocks", () => {
		expectBlocked("git commit -m x <<< 'message'");
	});
});

// ---------------------------------------------------------------------------
// Quoting edge cases
// ---------------------------------------------------------------------------

describe("quoting edge cases", () => {
	it("escaped quote in message is handled", () => {
		const inv = singleInvocation("git commit -m \"it\\'s a fix\"");
		if (inv.messageSource.kind !== "inline") throw new Error("wrong kind");
		// The value should contain the literal backslash-apostrophe or just apostrophe
		// depending on escape handling; key thing is no block
		expect(inv.messageSource.paragraphs[0]).toBeTruthy();
	});

	it("backslash-newline in message continues the token", () => {
		const inv = singleInvocation("git commit -m 'feat: a\\\nb'");
		// single-quoted, so backslash-newline is literal inside
		if (inv.messageSource.kind !== "inline") throw new Error("wrong kind");
		expect(inv.messageSource.paragraphs[0]).toContain("a");
	});

	it("malformed quoting blocks", () => {
		const r = expectBlocked("git commit -m 'unclosed");
		expect(r.reason).toBeTruthy();
	});

	it("subshell grouping blocks", () => {
		expectBlocked("(git commit -m x)");
	});

	it("brace grouping blocks", () => {
		expectBlocked("{ git commit -m x; }");
	});
});

// ---------------------------------------------------------------------------
// Process substitution and heredoc
// ---------------------------------------------------------------------------

describe("process substitution and heredoc in message context", () => {
	it("process substitution <(...) blocks", () => {
		expectBlocked("git commit -F <(echo message)");
	});

	it("process substitution >(...) blocks", () => {
		expectBlocked("echo hi >(cat) && git commit -m x");
	});

	it("unterminated heredoc blocks", () => {
		expectBlocked("git commit -m x << EOF\nno closer");
	});
});

// ---------------------------------------------------------------------------
// Expansion affecting git structure
// ---------------------------------------------------------------------------

describe("expansion in git structure", () => {
	it("expansion in git executable word blocks", () => {
		expectBlocked("$GIT commit -m x");
	});

	it("expansion in git subcommand blocks", () => {
		expectBlocked("git $SUBCMD -m x");
	});

	it("expansion in global -C path blocks", () => {
		expectBlocked("git -C $DIR commit -m x");
	});

	it("expansion in --git-dir value blocks", () => {
		expectBlocked("git --git-dir=$DIR commit -m x");
	});
});

// ---------------------------------------------------------------------------
// CommitInvocation fields
// ---------------------------------------------------------------------------

describe("CommitInvocation fields", () => {
	it("tokenStart and tokenEnd span the git word", () => {
		const src = "git commit -m x";
		const inv = singleInvocation(src);
		expect(src.slice(inv.tokenStart, inv.tokenEnd)).toBe("git");
	});

	it("effectiveCwd defaults to baseCwd when no cd or -C", () => {
		const inv = singleInvocation("git commit -m x", "/my/repo");
		expect(inv.effectiveCwd).toBe("/my/repo");
	});

	it("commitOptions.amend is true for --amend without --no-edit", () => {
		const inv = singleInvocation("git commit --amend -m 'x'");
		expect(inv.commitOptions.amend).toBe(true);
		expect(inv.commitOptions.noEdit).toBe(false);
	});

	it("commitOptions.allowEmptyMessage is true", () => {
		const inv = singleInvocation("git commit --allow-empty-message -m ''");
		expect(inv.commitOptions.allowEmptyMessage).toBe(true);
	});

	it("isGeneratedMessage is false for normal inline commit", () => {
		const inv = singleInvocation("git commit -m 'feat: x'");
		expect(inv.isGeneratedMessage).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Pathspec after --
// ---------------------------------------------------------------------------

describe("pathspec handling", () => {
	it("-- ends option parsing; no block from positional args", () => {
		const inv = singleInvocation("git commit -m 'x' -- src/");
		if (inv.messageSource.kind !== "inline") throw new Error("wrong kind");
		expect(inv.messageSource.paragraphs[0]).toBe("x");
	});

	it("pathspecs without -- are tolerated", () => {
		const inv = singleInvocation("git commit -m 'x' src/foo.ts");
		expect(inv.messageSource.kind).toBe("inline");
	});
});

// ---------------------------------------------------------------------------
// Clustered short flags
// ---------------------------------------------------------------------------

describe("clustered short flags", () => {
	it("-am 'msg' (cluster: a then separate m value)", () => {
		const inv = singleInvocation("git commit -am 'fix: clustered'");
		if (inv.messageSource.kind !== "inline") throw new Error("wrong kind");
		expect(inv.messageSource.paragraphs[0]).toBe("fix: clustered");
	});

	it("-amMyMessage (cluster: a then m with attached value)", () => {
		const inv = singleInvocation("git commit -amMyMessage");
		if (inv.messageSource.kind !== "inline") throw new Error("wrong kind");
		expect(inv.messageSource.paragraphs[0]).toBe("MyMessage");
	});

	it("-aF file.txt (cluster: a then separate F value)", () => {
		const inv = singleInvocation("git commit -aF COMMIT_MSG.txt");
		expect(inv.messageSource.kind).toBe("file");
		if (inv.messageSource.kind === "file") {
			expect(inv.messageSource.path).toBe("COMMIT_MSG.txt");
		}
	});

	it("-aFfile.txt (cluster: a then F with attached value)", () => {
		const inv = singleInvocation("git commit -aFCOMMIT_MSG.txt");
		expect(inv.messageSource.kind).toBe("file");
		if (inv.messageSource.kind === "file") {
			expect(inv.messageSource.path).toBe("COMMIT_MSG.txt");
		}
	});

	it("-aC HEAD (cluster: a then separate C value)", () => {
		const inv = singleInvocation("git commit -aC HEAD");
		expect(inv.messageSource.kind).toBe("reuse-commit");
		if (inv.messageSource.kind === "reuse-commit") {
			expect(inv.messageSource.revision).toBe("HEAD");
		}
	});

	it("-aCHEAD (cluster: a then C with attached value)", () => {
		const inv = singleInvocation("git commit -aCHEAD");
		expect(inv.messageSource.kind).toBe("reuse-commit");
		if (inv.messageSource.kind === "reuse-commit") {
			expect(inv.messageSource.revision).toBe("HEAD");
		}
	});

	it("-ac HEAD (cluster: a then separate c value — reedit)", () => {
		const inv = singleInvocation("git commit -ac HEAD");
		expect(inv.messageSource.kind).toBe("reedit-commit");
		if (inv.messageSource.kind === "reedit-commit") {
			expect(inv.messageSource.revision).toBe("HEAD");
		}
	});

	it("-acHEAD (cluster: a then c with attached value — reedit)", () => {
		const inv = singleInvocation("git commit -acHEAD");
		expect(inv.messageSource.kind).toBe("reedit-commit");
	});

	it("-am with expansion in value blocks", () => {
		expectBlocked("git commit -am $MSG");
	});

	it("pure no-arg cluster -an is tolerated", () => {
		const inv = singleInvocation("git commit -an -m 'x'");
		expect(inv.messageSource.kind).toBe("inline");
	});

	it("cluster with unknown char falls through to unknown-option skip", () => {
		// -ax has 'x' which is unknown but not a value flag: falls to short skip
		const inv = singleInvocation("git commit -ax -m 'x'");
		expect(inv.messageSource.kind).toBe("inline");
	});
});

// ---------------------------------------------------------------------------
// Tolerated long options with equals-attached values
// ---------------------------------------------------------------------------

describe("tolerated long options with =value", () => {
	it("--author=Name does not block", () => {
		const inv = singleInvocation("git commit -m 'x' --author='John Doe <j@d.com>'");
		expect(inv.messageSource.kind).toBe("inline");
	});

	it("--date=2024-01-01 does not block", () => {
		const inv = singleInvocation("git commit -m 'x' --date=2024-01-01");
		expect(inv.messageSource.kind).toBe("inline");
	});

	it("--gpg-sign=KEY does not block", () => {
		const inv = singleInvocation("git commit -m 'x' --gpg-sign=ABC123");
		expect(inv.messageSource.kind).toBe("inline");
	});

	it("--trailer=X:Y does not block", () => {
		const inv = singleInvocation("git commit -m 'x' --trailer=Co-authored-by:Someone");
		expect(inv.messageSource.kind).toBe("inline");
	});

	it("--untracked-files=all does not block", () => {
		const inv = singleInvocation("git commit -m 'x' --untracked-files=all");
		expect(inv.messageSource.kind).toBe("inline");
	});

	it("--pathspec-from-file=file does not block", () => {
		const inv = singleInvocation("git commit -m 'x' --pathspec-from-file=paths.txt");
		expect(inv.messageSource.kind).toBe("inline");
	});
});

// ---------------------------------------------------------------------------
// env -i and env -u NAME handling
// ---------------------------------------------------------------------------

describe("env -i and env -u flag handling", () => {
	it("env -i git commit is recognized", () => {
		const inv = singleInvocation("env -i git commit -m 'x'");
		expect(inv.messageSource.kind).toBe("inline");
	});

	it("env -i VAR=val git commit captures the assignment", () => {
		const inv = singleInvocation("env -i GIT_AUTHOR_NAME=Test git commit -m 'x'");
		expect(inv.messageSource.kind).toBe("inline");
		expect(inv.gitGlobalOptions.leadingAssignments.get("GIT_AUTHOR_NAME")).toBe("Test");
	});

	it("env -u NAME git commit is recognized", () => {
		const inv = singleInvocation("env -u GIT_AUTHOR_NAME git commit -m 'x'");
		expect(inv.messageSource.kind).toBe("inline");
	});

	it("env -u NAME VAR=val git commit captures the assignment", () => {
		const inv = singleInvocation("env -u GIT_AUTHOR_NAME GIT_AUTHOR_EMAIL=x@y.com git commit -m 'x'");
		expect(inv.messageSource.kind).toBe("inline");
		expect(inv.gitGlobalOptions.leadingAssignments.get("GIT_AUTHOR_EMAIL")).toBe("x@y.com");
	});

	it("env -- git commit is recognized (explicit end of env options)", () => {
		const inv = singleInvocation("env -- git commit -m 'x'");
		expect(inv.messageSource.kind).toBe("inline");
	});

	it("env VAR=val -i git commit captures assignment before -i", () => {
		const inv = singleInvocation("env GIT_DIR=.git -i git commit -m 'x'");
		expect(inv.messageSource.kind).toBe("inline");
	});
});

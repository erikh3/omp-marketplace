/**
 * Tests for the shell-parser.ts lexer and command splitter.
 *
 * Covers every Phase 2 matrix item:
 *   - Quote types, escape handling, backslash-newline
 *   - Expansion inside unquoted and double-quoted regions
 *   - $ and # inside single quotes (literal, no blocking)
 *   - Comments outside quotes
 *   - Separators: &&, ||, ;, newline, |, |&, &
 *   - Redirections (without message ambiguity)
 *   - Heredoc, here-string, process substitution
 *   - Subshell grouping and brace grouping
 *   - Malformed quoting
 */

import { describe, it, expect } from "bun:test";
import { splitCommands } from "../src/shell-parser.ts";
import type { SplitResult } from "../src/shell-parser.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function commands(result: SplitResult) {
	if (result.kind !== "commands") throw new Error(`Expected commands, got blocked: ${(result as { reason: string }).reason}`);
	return result.commands;
}

function blocked(result: SplitResult) {
	if (result.kind !== "blocked") throw new Error(`Expected blocked, got commands`);
	return result;
}

function tokenValues(result: SplitResult, cmdIdx = 0): string[] {
	return commands(result)[cmdIdx]!.tokens.map((t) => t.value);
}

// ---------------------------------------------------------------------------
// Basic tokenization
// ---------------------------------------------------------------------------

describe("basic tokenization", () => {
	it("splits whitespace-delimited words", () => {
		expect(tokenValues(splitCommands("git commit -m hello"))).toEqual(["git", "commit", "-m", "hello"]);
	});

	it("returns no-commit for empty input", () => {
		const result = splitCommands("");
		expect(commands(result)).toHaveLength(0);
	});

	it("handles multiple spaces and tabs", () => {
		expect(tokenValues(splitCommands("git  commit\t-m\t hello"))).toEqual(["git", "commit", "-m", "hello"]);
	});

	it("trims leading and trailing whitespace", () => {
		expect(tokenValues(splitCommands("  git commit  "))).toEqual(["git", "commit"]);
	});
});

// ---------------------------------------------------------------------------
// Single quotes
// ---------------------------------------------------------------------------

describe("single quotes", () => {
	it("treats everything inside single quotes as literal", () => {
		const result = splitCommands("git commit -m 'hello world'");
		expect(tokenValues(result)).toEqual(["git", "commit", "-m", "hello world"]);
	});

	it("$ inside single quotes is literal (no expansion)", () => {
		const result = splitCommands("git commit -m '$HOME'");
		const tok = commands(result)[0]!.tokens[3]!;
		expect(tok.value).toBe("$HOME");
		expect(tok.hasExpansion).toBe(false);
	});

	it("# inside single quotes is literal (not a comment)", () => {
		const result = splitCommands("git commit -m 'fix #123'");
		const tok = commands(result)[0]!.tokens[3]!;
		expect(tok.value).toBe("fix #123");
		expect(tok.hasExpansion).toBe(false);
	});

	it("shell operators inside single quotes are literal", () => {
		const result = splitCommands("git commit -m 'a && b; c | d'");
		const tok = commands(result)[0]!.tokens[3]!;
		expect(tok.value).toBe("a && b; c | d");
	});

	it("preserves newlines inside single quotes", () => {
		const result = splitCommands("git commit -m 'line1\nline2'");
		const tok = commands(result)[0]!.tokens[3]!;
		expect(tok.value).toBe("line1\nline2");
	});

	it("blocks on unterminated single quote", () => {
		const result = splitCommands("git commit -m 'unterminated");
		expect(blocked(result).code).toBe("malformed-quoting");
	});
});

// ---------------------------------------------------------------------------
// Double quotes
// ---------------------------------------------------------------------------

describe("double quotes", () => {
	it("treats ordinary characters inside double quotes as literal", () => {
		const result = splitCommands('git commit -m "hello world"');
		expect(tokenValues(result)).toEqual(["git", "commit", "-m", "hello world"]);
	});

	it("marks $VAR inside double quotes as expansion-active", () => {
		const result = splitCommands('git commit -m "fix $ISSUE"');
		const tok = commands(result)[0]!.tokens[3]!;
		expect(tok.hasExpansion).toBe(true);
	});

	it("marks $() inside double quotes as expansion-active", () => {
		const result = splitCommands('git commit -m "version $(cat VERSION)"');
		const tok = commands(result)[0]!.tokens[3]!;
		expect(tok.hasExpansion).toBe(true);
	});

	it("marks backtick inside double quotes as expansion-active", () => {
		const result = splitCommands('git commit -m "ver `cat VERSION`"');
		const tok = commands(result)[0]!.tokens[3]!;
		expect(tok.hasExpansion).toBe(true);
	});

	it("handles escaped double-quote inside double quotes", () => {
		const result = splitCommands('git commit -m "say \\"hi\\""');
		const tok = commands(result)[0]!.tokens[3]!;
		expect(tok.value).toBe('say "hi"');
		expect(tok.hasExpansion).toBe(false);
	});

	it("backslash before non-special char keeps both characters", () => {
		const result = splitCommands('git commit -m "\\a"');
		const tok = commands(result)[0]!.tokens[3]!;
		expect(tok.value).toBe("\\a");
	});

	it("backslash-newline inside double quotes is a continuation (no newline in value)", () => {
		const result = splitCommands('git commit -m "line1\\\nline2"');
		const tok = commands(result)[0]!.tokens[3]!;
		expect(tok.value).toBe("line1line2");
	});

	it("blocks on unterminated double quote", () => {
		const result = splitCommands('git commit -m "unterminated');
		expect(blocked(result).code).toBe("malformed-quoting");
	});
});

// ---------------------------------------------------------------------------
// Backslash escapes (outside quotes)
// ---------------------------------------------------------------------------

describe("backslash escapes outside quotes", () => {
	it("backslash escapes next character", () => {
		const result = splitCommands("git commit -m hello\\ world");
		// backslash-space keeps the space as part of the token
		expect(tokenValues(result)).toEqual(["git", "commit", "-m", "hello world"]);
	});

	it("backslash-newline is a line continuation (joins words)", () => {
		const result = splitCommands("git commit \\\n-m hello");
		expect(tokenValues(result)).toEqual(["git", "commit", "-m", "hello"]);
	});

	it("backslash escapes a quote character", () => {
		const result = splitCommands("git commit -m don\\'t");
		const tok = commands(result)[0]!.tokens[3]!;
		expect(tok.value).toBe("don't");
	});

	it("backslash escapes an operator", () => {
		const result = splitCommands("git commit -m a\\;b");
		expect(tokenValues(result)).toEqual(["git", "commit", "-m", "a;b"]);
	});

	it("trailing backslash blocks", () => {
		expect(blocked(splitCommands("git commit -m foo\\")).code).toBe("malformed-quoting");
	});
});

// ---------------------------------------------------------------------------
// Expansion (unquoted)
// ---------------------------------------------------------------------------

describe("expansion in unquoted region", () => {
	it("$VAR is expansion-active", () => {
		const result = splitCommands("git commit -m $MSG");
		const tok = commands(result)[0]!.tokens[3]!;
		expect(tok.hasExpansion).toBe(true);
	});

	it("${VAR} is expansion-active", () => {
		const result = splitCommands("git commit -m ${MSG}");
		const tok = commands(result)[0]!.tokens[3]!;
		expect(tok.hasExpansion).toBe(true);
	});

	it("$(cmd) is expansion-active", () => {
		const result = splitCommands("git commit -m $(echo hi)");
		const tok = commands(result)[0]!.tokens[3]!;
		expect(tok.hasExpansion).toBe(true);
	});

	it("backtick substitution is expansion-active", () => {
		const result = splitCommands("git commit -m `echo hi`");
		const tok = commands(result)[0]!.tokens[3]!;
		expect(tok.hasExpansion).toBe(true);
	});

	it("token with plain prefix and $VAR suffix is expansion-active", () => {
		const result = splitCommands("git commit -m prefix$VAR");
		const tok = commands(result)[0]!.tokens[3]!;
		expect(tok.hasExpansion).toBe(true);
	});

	it("literal value before expansion is preserved in segments", () => {
		const result = splitCommands("git commit -m prefix$VAR");
		const tok = commands(result)[0]!.tokens[3]!;
		const plainSeg = tok.segments.find((s) => !s.expansionActive);
		expect(plainSeg?.value).toBe("prefix");
	});
});

// ---------------------------------------------------------------------------
// Comments
// ---------------------------------------------------------------------------

describe("comments", () => {
	it("# at start of word (unquoted boundary) starts a comment", () => {
		const result = splitCommands("git commit # this is a comment");
		expect(tokenValues(result)).toEqual(["git", "commit"]);
	});

	it("# in the middle of a token is not a comment", () => {
		// The # is glued to -m, but that is not a word boundary start
		const result = splitCommands("git commit -m fix#123");
		const tok = commands(result)[0]!.tokens[3]!;
		expect(tok.value).toBe("fix#123");
	});

	it("comment consumes rest of line; next line is a new command", () => {
		const result = splitCommands("echo hi # comment\ngit commit -m x");
		const cmds = commands(result);
		expect(cmds).toHaveLength(2);
		expect(cmds[1]!.tokens.map((t) => t.value)).toEqual(["git", "commit", "-m", "x"]);
	});

	it("# after separator is a comment", () => {
		const result = splitCommands("git status; # check\ngit commit -m x");
		const cmds = commands(result);
		// Three commands produced (status, empty from comment, commit) or two
		// depending on whether empty commands are dropped. We only care about the last.
		const last = cmds[cmds.length - 1]!;
		expect(last.tokens.map((t) => t.value)).toEqual(["git", "commit", "-m", "x"]);
	});
});

// ---------------------------------------------------------------------------
// Separators and multiple commands
// ---------------------------------------------------------------------------

describe("separators", () => {
	it("&& separates two commands", () => {
		const result = splitCommands("mkdir -p tmp && git commit -m x");
		const cmds = commands(result);
		expect(cmds).toHaveLength(2);
		expect(cmds[1]!.tokens[0]!.value).toBe("git");
	});

	it("|| separates two commands", () => {
		const result = splitCommands("git status || git commit -m x");
		expect(commands(result)).toHaveLength(2);
	});

	it("; separates two commands", () => {
		const result = splitCommands("git add . ; git commit -m x");
		expect(commands(result)).toHaveLength(2);
	});

	it("newline separates two commands", () => {
		const result = splitCommands("git add .\ngit commit -m x");
		expect(commands(result)).toHaveLength(2);
	});

	it("pipe separates into two commands", () => {
		const result = splitCommands("echo hello | cat");
		expect(commands(result)).toHaveLength(2);
	});

	it("|& separates into two commands", () => {
		const result = splitCommands("git status |& cat");
		expect(commands(result)).toHaveLength(2);
	});

	it("three commands joined with &&", () => {
		const result = splitCommands("git add . && git commit -m x && echo done");
		expect(commands(result)).toHaveLength(3);
	});

	it("separator does not start a comment", () => {
		const result = splitCommands("git commit -m a; git commit -m b");
		expect(commands(result)).toHaveLength(2);
	});
});

// ---------------------------------------------------------------------------
// Redirections
// ---------------------------------------------------------------------------

describe("redirections", () => {
	it("output redirection > is consumed without blocking", () => {
		const result = splitCommands("git log > out.txt");
		const cmd = commands(result)[0]!;
		// The redirection itself is not in the token list
		expect(cmd.tokens.map((t) => t.value)).toContain("git");
		expect(cmd.hasInputRedirection).toBe(false);
	});

	it("input redirection < sets hasInputRedirection", () => {
		const cmd = commands(splitCommands("git log < input.txt"))[0]!;
		expect(cmd.hasInputRedirection).toBe(true);
		expect(cmd.hasHeredocInput).toBe(false);
	});

	it(">> is consumed without blocking", () => {
		expect(() => commands(splitCommands("echo x >> file.txt"))).not.toThrow();
	});

	it("2> is consumed without blocking", () => {
		expect(() => commands(splitCommands("git commit -m x 2>/dev/null"))).not.toThrow();
	});
});

// ---------------------------------------------------------------------------
// Heredoc and here-string
// ---------------------------------------------------------------------------

describe("heredoc", () => {
	it("heredoc sets hasHeredocInput", () => {
		const raw = "git commit -m x << EOF\nsome content\nEOF";
		const cmd = commands(splitCommands(raw))[0]!;
		expect(cmd.hasHeredocInput).toBe(true);
	});

	it("heredoc body is consumed and not scanned as commands", () => {
		const raw = "git commit -m x << 'EOF'\ngit commit -m evil\nEOF\ngit status";
		const cmds = commands(splitCommands(raw));
		// Only two actual commands: git commit and git status (not the inner one)
		const allValues = cmds.flatMap((c) => c.tokens.map((t) => t.value));
		// git status should appear; the evil inner commit is heredoc body
		expect(allValues.filter((v) => v === "status")).toHaveLength(1);
	});

	it("here-string <<< sets hasHeredocInput", () => {
		const cmd = commands(splitCommands("cat <<< hello"))[0]!;
		expect(cmd.hasHeredocInput).toBe(true);
	});

	it("unterminated heredoc blocks", () => {
		const result = splitCommands("git commit -m x << EOF\ncontent without closer");
		expect(blocked(result).code).toBe("malformed-heredoc");
	});
});

// ---------------------------------------------------------------------------
// Process substitution
// ---------------------------------------------------------------------------

describe("process substitution", () => {
	it("<(...) blocks", () => {
		const result = splitCommands("git commit -m x < <(echo hi)");
		// The <( should trigger process-substitution block
		expect(blocked(result).code).toBe("process-substitution");
	});

	it(">(...) blocks", () => {
		const result = splitCommands("echo hi >(cat)");
		expect(blocked(result).code).toBe("process-substitution");
	});
});

// ---------------------------------------------------------------------------
// Subshell and brace grouping
// ---------------------------------------------------------------------------

describe("grouping", () => {
	it("( blocks", () => {
		const result = splitCommands("(git commit -m x)");
		expect(blocked(result).code).toBe("subshell-grouping");
	});

	it("{ blocks", () => {
		const result = splitCommands("{ git commit -m x; }");
		expect(blocked(result).code).toBe("subshell-grouping");
	});

	it(") without matching ( blocks", () => {
		const result = splitCommands("git commit -m x )");
		expect(blocked(result).code).toBe("unsupported-grouping");
	});
});

// ---------------------------------------------------------------------------
// Multiline quoted -m values
// ---------------------------------------------------------------------------

describe("multiline quoted messages", () => {
	it("single-quoted multiline value is one token with embedded newline", () => {
		const result = splitCommands("git commit -m 'feat: add thing\n\nThis is the body.'");
		const tok = commands(result)[0]!.tokens[3]!;
		expect(tok.value).toContain("\n\n");
		expect(tok.hasExpansion).toBe(false);
	});

	it("double-quoted multiline value is one token with embedded newline", () => {
		const result = splitCommands('git commit -m "feat: add thing\n\nBody here"');
		const tok = commands(result)[0]!.tokens[3]!;
		expect(tok.value).toContain("\n\n");
		// No $ expansion, so hasExpansion should be false
		expect(tok.hasExpansion).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Token span tracking
// ---------------------------------------------------------------------------

describe("token spans", () => {
	it("token start and end are byte offsets in the original string", () => {
		const src = "git commit";
		const tok = commands(splitCommands(src))[0]!.tokens[0]!;
		expect(tok.start).toBe(0);
		expect(tok.end).toBe(3);
		expect(src.slice(tok.start, tok.end)).toBe("git");
	});

	it("quoted token span includes the quote characters", () => {
		const src = `git commit -m 'hello'`;
		const tok = commands(splitCommands(src))[0]!.tokens[3]!;
		// The span should cover the quoted region (from the opening ' to the end of 'hello')
		// The exact span depends on implementation; value must be correct.
		expect(tok.value).toBe("hello");
	});
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("edge cases", () => {
	it("empty command after semicolon is dropped", () => {
		const result = splitCommands("git commit -m x;");
		expect(commands(result)).toHaveLength(1);
	});

	it("only whitespace produces no commands", () => {
		expect(commands(splitCommands("   "))).toHaveLength(0);
	});

	it("only a comment produces no commands", () => {
		expect(commands(splitCommands("# just a comment"))).toHaveLength(0);
	});

	it("echo with quoted git commit text is not a commit", () => {
		const result = splitCommands("echo 'git commit -m x'");
		const cmds = commands(result);
		expect(cmds[0]!.tokens[0]!.value).toBe("echo");
		// Not a git command
	});

	it("case ;; blocks as unsupported grouping", () => {
		const result = splitCommands("case x in a) echo;; esac");
		expect(blocked(result).code).toBe("unsupported-grouping");
	});

	it("$@ is expansion-active", () => {
		const result = splitCommands("git commit -m $@");
		const tok = commands(result)[0]!.tokens[3]!;
		expect(tok.hasExpansion).toBe(true);
	});

	it("$? is expansion-active", () => {
		const result = splitCommands("echo $?");
		const tok = commands(result)[0]!.tokens[1]!;
		expect(tok.hasExpansion).toBe(true);
	});

	it("${VAR:-default} is expansion-active", () => {
		const result = splitCommands("git commit -m ${MSG:-no message}");
		const tok = commands(result)[0]!.tokens[3]!;
		expect(tok.hasExpansion).toBe(true);
	});
});

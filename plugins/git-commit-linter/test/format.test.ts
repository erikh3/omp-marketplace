import { describe, expect, test } from "bun:test";
import type { LintRuleOutcome } from "@commitlint/types";
import {
	HEADER_PREVIEW_LIMIT,
	formatBlockReason,
	formatBrokenConfigWarning,
	formatHeaderPreview,
	formatLintErrors,
} from "../src/format.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeError(name: string, message: string): LintRuleOutcome {
	return { level: 2, valid: false, name, message };
}

// ---------------------------------------------------------------------------
// formatHeaderPreview
// ---------------------------------------------------------------------------

describe("formatHeaderPreview", () => {
	test("returns short strings unchanged", () => {
		expect(formatHeaderPreview("fix: correct typo")).toBe("fix: correct typo");
	});

	test("uses exactly HEADER_PREVIEW_LIMIT code points without truncation", () => {
		const exact = "a".repeat(HEADER_PREVIEW_LIMIT);
		expect(formatHeaderPreview(exact)).toBe(exact);
		expect([...formatHeaderPreview(exact)].length).toBe(HEADER_PREVIEW_LIMIT);
	});

	test("truncates one code point over the limit with ellipsis", () => {
		const over = "a".repeat(HEADER_PREVIEW_LIMIT + 1);
		const result = formatHeaderPreview(over);
		const codePoints = [...result];
		expect(codePoints.length).toBe(HEADER_PREVIEW_LIMIT);
		expect(codePoints[codePoints.length - 1]).toBe("\u2026");
	});

	test("truncates well over the limit, preserving only HEADER_PREVIEW_LIMIT code points total", () => {
		const long = "x".repeat(200);
		const result = formatHeaderPreview(long);
		expect([...result].length).toBe(HEADER_PREVIEW_LIMIT);
		expect(result.endsWith("\u2026")).toBe(true);
	});

	test("counts Unicode supplementary characters (emoji) as one code point each", () => {
		// Each 🐛 is U+1F41B, one code point but two UTF-16 code units.
		const emoji = "🐛".repeat(HEADER_PREVIEW_LIMIT);
		const result = formatHeaderPreview(emoji);
		// No truncation: exactly HEADER_PREVIEW_LIMIT code points.
		expect([...result].length).toBe(HEADER_PREVIEW_LIMIT);
		expect(result).toBe(emoji);
	});

	test("truncates supplementary characters correctly", () => {
		const emoji = "🐛".repeat(HEADER_PREVIEW_LIMIT + 5);
		const result = formatHeaderPreview(emoji);
		expect([...result].length).toBe(HEADER_PREVIEW_LIMIT);
		expect(result.endsWith("\u2026")).toBe(true);
	});

	test("takes only the first line on \\n", () => {
		expect(formatHeaderPreview("subject\nbody line")).toBe("subject");
	});

	test("takes only the first line on \\r\\n", () => {
		expect(formatHeaderPreview("subject\r\nbody line")).toBe("subject");
	});

	test("takes only the first line on bare \\r", () => {
		expect(formatHeaderPreview("subject\rbody line")).toBe("subject");
	});

	test("returns empty string for empty input", () => {
		expect(formatHeaderPreview("")).toBe("");
	});

	test("replaces NUL byte with space", () => {
		expect(formatHeaderPreview("fix\x00null")).toBe("fix null");
	});

	test("replaces non-newline C0 control characters with spaces", () => {
		// U+0000–U+0009 (before \n) and U+000B–U+000C and U+000E–U+001F are
		// non-line-break C0 controls. Verify a sample from each region.
		expect(formatHeaderPreview("\x00\x01\x08\x09")).toBe("    ");
		expect(formatHeaderPreview("\x0B\x0C")).toBe("  ");
		expect(formatHeaderPreview("\x0E\x1F")).toBe("  ");
	});

	test("line-break C0 controls (\\n, \\r) are treated as line separators, not spaces", () => {
		// \n splits; only what precedes it appears.
		expect(formatHeaderPreview("before\nafter")).toBe("before");
		// \r splits; only what precedes it appears.
		expect(formatHeaderPreview("before\rafter")).toBe("before");
		// \r\n together split too.
		expect(formatHeaderPreview("before\r\nafter")).toBe("before");
	});

	test("replaces DEL (U+007F) with space", () => {
		expect(formatHeaderPreview("a\x7Fb")).toBe("a b");
	});

	test("does not alter non-ASCII printable characters", () => {
		const input = "feat: café résumé naïve";
		expect(formatHeaderPreview(input)).toBe(input);
	});

	test("does not alter CJK characters", () => {
		const input = "fix: 修复登录问题";
		expect(formatHeaderPreview(input)).toBe(input);
	});

	test("body is never included, only subject", () => {
		const msg = "feat: add login\n\nThis PR adds a login flow.\n\nRefs #42";
		expect(formatHeaderPreview(msg)).toBe("feat: add login");
	});

	test("truncates a multiline input's first line when it exceeds the limit", () => {
		const longSubject = "f".repeat(HEADER_PREVIEW_LIMIT + 10);
		const msg = `${longSubject}\n\nbody text`;
		const result = formatHeaderPreview(msg);
		expect([...result].length).toBe(HEADER_PREVIEW_LIMIT);
		expect(result.endsWith("\u2026")).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// formatBlockReason
// ---------------------------------------------------------------------------

describe("formatBlockReason", () => {
	test("includes the reason", () => {
		const result = formatBlockReason("expansion in message path", "");
		expect(result).toContain("expansion in message path");
	});

	test("indicates the commit is blocked", () => {
		const result = formatBlockReason("some reason", "");
		expect(result.toLowerCase()).toContain("blocked");
	});

	test("includes a command preview when a raw command is provided", () => {
		const result = formatBlockReason("heredoc in message", "git commit --message=$(cat file.txt)");
		expect(result).toContain("git commit --message=$(cat file.txt)");
	});

	test("omits the command line when rawCommand is empty", () => {
		const result = formatBlockReason("unknown failure", "");
		expect(result).not.toContain("Command:");
	});

	test("omits the command line when rawCommand is whitespace only", () => {
		const result = formatBlockReason("reason", "   ");
		expect(result).not.toContain("Command:");
	});

	test("normalizes control characters in the command preview", () => {
		const result = formatBlockReason("reason", "git commit -m 'test\x00msg'");
		expect(result).not.toContain("\x00");
	});

	test("truncates a long command preview", () => {
		const longCmd = "git commit -m '" + "x".repeat(200) + "'";
		const result = formatBlockReason("reason", longCmd);
		// Find the Command: line and check its value is bounded.
		const commandLine = result.split("\n").find((l) => l.startsWith("Command:")) ?? "";
		const preview = commandLine.slice("Command: ".length);
		expect([...preview].length).toBeLessThanOrEqual(HEADER_PREVIEW_LIMIT);
	});

	test("does not include body content from a multiline command", () => {
		const result = formatBlockReason("malformed quoting", "git commit -m 'line1\nline2'");
		// body line should not appear
		expect(result).not.toContain("line2");
	});
});

// ---------------------------------------------------------------------------
// formatLintErrors
// ---------------------------------------------------------------------------

describe("formatLintErrors", () => {
	test("includes the commit header preview", () => {
		const result = formatLintErrors("bad commit message", [makeError("subject-case", "subject must be lower-case")]);
		expect(result).toContain("bad commit message");
	});

	test("indicates the commit is blocked", () => {
		const result = formatLintErrors("wip", [makeError("type-empty", "type may not be empty")]);
		expect(result.toLowerCase()).toContain("blocked");
	});

	test("formats one error as [rule] message", () => {
		const result = formatLintErrors("wip", [makeError("type-empty", "type may not be empty")]);
		expect(result).toContain("[type-empty] type may not be empty");
	});

	test("formats multiple errors, all included", () => {
		const errors = [
			makeError("type-empty", "type may not be empty"),
			makeError("subject-empty", "subject may not be empty"),
			makeError("subject-case", "subject must be lower-case"),
		];
		const result = formatLintErrors("WIP", errors);
		expect(result).toContain("[type-empty] type may not be empty");
		expect(result).toContain("[subject-empty] subject may not be empty");
		expect(result).toContain("[subject-case] subject must be lower-case");
	});

	test("does not include the commit body", () => {
		const result = formatLintErrors(
			"bad header",
			[makeError("type-empty", "type may not be empty")],
		);
		// No body content should appear — format only receives the header anyway,
		// but verify nothing body-like leaks into the output.
		expect(result).not.toContain("body");
	});

	test("truncates a long header to HEADER_PREVIEW_LIMIT code points", () => {
		const longHeader = "a".repeat(HEADER_PREVIEW_LIMIT + 20);
		const result = formatLintErrors(longHeader, [makeError("header-max-length", "header must not be longer than 72 characters")]);
		const headerLine = result.split("\n").find((l) => l.startsWith("Header:")) ?? "";
		const preview = headerLine.slice("Header: ".length);
		expect([...preview].length).toBeLessThanOrEqual(HEADER_PREVIEW_LIMIT);
		expect(preview.endsWith("\u2026")).toBe(true);
	});

	test("normalizes control characters in the header preview", () => {
		const result = formatLintErrors("fix\x01something", [makeError("type-enum", "type must be one of [feat, fix]")]);
		expect(result).not.toContain("\x01");
	});

	test("handles a single-character header without truncation", () => {
		const result = formatLintErrors("x", [makeError("subject-empty", "subject may not be empty")]);
		expect(result).toContain("Header: x");
	});

	test("uses only the first line of a multiline header input", () => {
		const result = formatLintErrors("subject line\n\nbody paragraph", [makeError("type-empty", "type may not be empty")]);
		expect(result).toContain("subject line");
		expect(result).not.toContain("body paragraph");
	});
});

// ---------------------------------------------------------------------------
// formatBrokenConfigWarning
// ---------------------------------------------------------------------------

describe("formatBrokenConfigWarning", () => {
	test("states that linting was skipped", () => {
		const result = formatBrokenConfigWarning("Cannot find module 'bad-plugin'", "/repo");
		expect(result.toLowerCase()).toContain("linting was skipped");
	});

	test("states the commit may have already executed", () => {
		const result = formatBrokenConfigWarning("SyntaxError: unexpected token", "/repo");
		expect(result.toLowerCase()).toContain("may have already executed");
	});

	test("includes the worktree root", () => {
		const result = formatBrokenConfigWarning("Cannot find module", "/workspace/my-repo");
		expect(result).toContain("/workspace/my-repo");
	});

	test("includes the config error message", () => {
		const result = formatBrokenConfigWarning("Cannot find module '@scope/bad-plugin'", "/repo");
		expect(result).toContain("Cannot find module '@scope/bad-plugin'");
	});

	test("does not contain retry language", () => {
		const result = formatBrokenConfigWarning("parse error", "/repo");
		const lower = result.toLowerCase();
		expect(lower).not.toContain("try again");
		expect(lower).not.toContain("retry");
		expect(lower).not.toContain("re-run");
		expect(lower).not.toContain("rerun");
		expect(lower).not.toContain("please run");
	});

	test("instructs the user to fix the config, not to retry the commit", () => {
		const result = formatBrokenConfigWarning("Cannot resolve extends", "/repo");
		expect(result.toLowerCase()).toContain("fix");
	});

	test("is a warning, not a block — does not say 'blocked'", () => {
		const result = formatBrokenConfigWarning("some error", "/repo");
		expect(result.toLowerCase()).not.toContain("blocked");
	});
});

// ---------------------------------------------------------------------------
// HEADER_PREVIEW_LIMIT export
// ---------------------------------------------------------------------------

describe("HEADER_PREVIEW_LIMIT", () => {
	test("is a positive integer", () => {
		expect(Number.isInteger(HEADER_PREVIEW_LIMIT)).toBe(true);
		expect(HEADER_PREVIEW_LIMIT).toBeGreaterThan(0);
	});
});

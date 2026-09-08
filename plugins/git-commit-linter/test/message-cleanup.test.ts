import { describe, it, expect } from "bun:test";
import { applyCleanup, resolveEffectiveMode } from "../src/message-cleanup.ts";

// ---------------------------------------------------------------------------
// resolveEffectiveMode
// ---------------------------------------------------------------------------

describe("resolveEffectiveMode", () => {
	it("passes through explicit strip", () => {
		expect(resolveEffectiveMode("strip", true)).toBe("strip");
		expect(resolveEffectiveMode("strip", false)).toBe("strip");
	});

	it("passes through explicit whitespace", () => {
		expect(resolveEffectiveMode("whitespace", true)).toBe("whitespace");
	});

	it("passes through verbatim", () => {
		expect(resolveEffectiveMode("verbatim", true)).toBe("verbatim");
	});

	it("passes through scissors", () => {
		expect(resolveEffectiveMode("scissors", false)).toBe("scissors");
	});

	it("resolves default to whitespace for non-editor source", () => {
		expect(resolveEffectiveMode("default", true)).toBe("whitespace");
	});

	it("resolves default to strip for editor source", () => {
		expect(resolveEffectiveMode("default", false)).toBe("strip");
	});
});

// ---------------------------------------------------------------------------
// verbatim
// ---------------------------------------------------------------------------

describe("applyCleanup — verbatim", () => {
	it("returns the raw string unchanged", () => {
		const raw = "  hello  \n# comment\n\n\ntrailing  \n";
		expect(applyCleanup(raw, { mode: "verbatim", commentChar: "#", nonEditorSource: true })).toBe(raw);
	});

	it("preserves empty string", () => {
		expect(applyCleanup("", { mode: "verbatim", commentChar: "#", nonEditorSource: true })).toBe("");
	});

	it("preserves strings with only whitespace", () => {
		expect(applyCleanup("   \n  \n", { mode: "verbatim", commentChar: "#", nonEditorSource: true })).toBe("   \n  \n");
	});
});

// ---------------------------------------------------------------------------
// whitespace
// ---------------------------------------------------------------------------

describe("applyCleanup — whitespace", () => {
	it("strips trailing whitespace from each line", () => {
		expect(applyCleanup("hello   \nworld  ", { mode: "whitespace", commentChar: "#", nonEditorSource: true }))
			.toBe("hello\nworld");
	});

	it("collapses consecutive blank lines into one", () => {
		expect(applyCleanup("a\n\n\n\nb", { mode: "whitespace", commentChar: "#", nonEditorSource: true }))
			.toBe("a\n\nb");
	});

	it("trims leading blank lines", () => {
		expect(applyCleanup("\n\nhello", { mode: "whitespace", commentChar: "#", nonEditorSource: true }))
			.toBe("hello");
	});

	it("trims trailing blank lines", () => {
		expect(applyCleanup("hello\n\n\n", { mode: "whitespace", commentChar: "#", nonEditorSource: true }))
			.toBe("hello");
	});

	it("preserves comment lines", () => {
		const raw = "feat: add thing\n# comment here\nsome body";
		expect(applyCleanup(raw, { mode: "whitespace", commentChar: "#", nonEditorSource: true }))
			.toBe("feat: add thing\n# comment here\nsome body");
	});

	it("preserves a single blank line between paragraphs", () => {
		const raw = "subject\n\nbody paragraph";
		expect(applyCleanup(raw, { mode: "whitespace", commentChar: "#", nonEditorSource: true }))
			.toBe("subject\n\nbody paragraph");
	});

	it("returns empty string for all-blank input", () => {
		expect(applyCleanup("   \n   \n\n", { mode: "whitespace", commentChar: "#", nonEditorSource: true }))
			.toBe("");
	});

	it("handles Windows-style CRLF-free content (internal \\n only)", () => {
		expect(applyCleanup("line1  \n\nline2  ", { mode: "whitespace", commentChar: "#", nonEditorSource: true }))
			.toBe("line1\n\nline2");
	});

	it("default + non-editor source resolves to whitespace, keeps comments", () => {
		const raw = "feat: x\n# comment\n";
		expect(applyCleanup(raw, { mode: "default", commentChar: "#", nonEditorSource: true }))
			.toBe("feat: x\n# comment");
	});
});

// ---------------------------------------------------------------------------
// strip
// ---------------------------------------------------------------------------

describe("applyCleanup — strip", () => {
	it("removes lines beginning with the comment character", () => {
		const raw = "feat: add thing\n# this is a comment\nbody text";
		expect(applyCleanup(raw, { mode: "strip", commentChar: "#", nonEditorSource: false }))
			.toBe("feat: add thing\nbody text");
	});

	it("applies whitespace cleanup in addition to comment removal", () => {
		const raw = "feat: x  \n# comment\n\n\nbody  ";
		expect(applyCleanup(raw, { mode: "strip", commentChar: "#", nonEditorSource: false }))
			.toBe("feat: x\n\nbody");
	});

	it("uses a custom comment character", () => {
		const raw = "feat: x\n; this is a comment\nbody";
		expect(applyCleanup(raw, { mode: "strip", commentChar: ";", nonEditorSource: false }))
			.toBe("feat: x\nbody");
	});

	it("leaves lines that only start with a different character", () => {
		const raw = "feat: x\n; comment\nbody";
		// commentChar is #, so semicolons are not comments
		expect(applyCleanup(raw, { mode: "strip", commentChar: "#", nonEditorSource: false }))
			.toBe("feat: x\n; comment\nbody");
	});

	it("collapses blank lines that result from comment removal", () => {
		const raw = "subject\n# comment\n# another\nbody";
		expect(applyCleanup(raw, { mode: "strip", commentChar: "#", nonEditorSource: false }))
			.toBe("subject\nbody");
	});

	it("returns empty string when all lines are comments", () => {
		expect(applyCleanup("# a\n# b\n", { mode: "strip", commentChar: "#", nonEditorSource: false }))
			.toBe("");
	});

	it("default + editor source resolves to strip", () => {
		const raw = "feat: x\n# comment\nbody";
		expect(applyCleanup(raw, { mode: "default", commentChar: "#", nonEditorSource: false }))
			.toBe("feat: x\nbody");
	});
});

// ---------------------------------------------------------------------------
// scissors — editor source (truncation applies)
// ---------------------------------------------------------------------------

describe("applyCleanup — scissors (editor source)", () => {
	const scissors = "# ------------------------ >8 ------------------------";

	it("truncates at the scissors line", () => {
		const raw = `feat: x\nbody\n${scissors}\nthis is discarded`;
		expect(applyCleanup(raw, { mode: "scissors", commentChar: "#", nonEditorSource: false }))
			.toBe("feat: x\nbody");
	});

	it("discards scissors line itself", () => {
		const raw = `subject\n${scissors}`;
		expect(applyCleanup(raw, { mode: "scissors", commentChar: "#", nonEditorSource: false }))
			.toBe("subject");
	});

	it("returns empty string when scissors is the first line", () => {
		const raw = `${scissors}\ndiscarded`;
		expect(applyCleanup(raw, { mode: "scissors", commentChar: "#", nonEditorSource: false }))
			.toBe("");
	});

	it("applies whitespace cleanup to content before scissors", () => {
		const raw = `feat: x  \n\n\nbody  \n${scissors}\ndiscarded`;
		expect(applyCleanup(raw, { mode: "scissors", commentChar: "#", nonEditorSource: false }))
			.toBe("feat: x\n\nbody");
	});

	it("leaves full message when no scissors line present", () => {
		const raw = "feat: x\nbody";
		expect(applyCleanup(raw, { mode: "scissors", commentChar: "#", nonEditorSource: false }))
			.toBe("feat: x\nbody");
	});

	it("works with custom comment character in scissors line", () => {
		const customScissors = "; ------------------------ >8 ------------------------";
		const raw = `feat: x\nbody\n${customScissors}\ndiscarded`;
		expect(applyCleanup(raw, { mode: "scissors", commentChar: ";", nonEditorSource: false }))
			.toBe("feat: x\nbody");
	});

	it("does not match a line with too few dashes", () => {
		// 7 dashes on each side — does not meet minimum 8
		const notScissors = "# ------- >8 -------";
		const raw = `subject\n${notScissors}\nbody`;
		expect(applyCleanup(raw, { mode: "scissors", commentChar: "#", nonEditorSource: false }))
			.toBe(`subject\n${notScissors}\nbody`);
	});
});

// ---------------------------------------------------------------------------
// scissors — non-editor source (no truncation)
// ---------------------------------------------------------------------------

describe("applyCleanup — scissors (non-editor source)", () => {
	const scissors = "# ------------------------ >8 ------------------------";

	it("preserves scissors line as content", () => {
		const raw = `feat: x\n${scissors}\nstill part of message`;
		expect(applyCleanup(raw, { mode: "scissors", commentChar: "#", nonEditorSource: true }))
			.toBe(`feat: x\n${scissors}\nstill part of message`);
	});

	it("applies whitespace cleanup but no truncation", () => {
		const raw = `feat: x  \n${scissors}  \nbody  `;
		// trailing whitespace is stripped from every line; scissors line kept
		expect(applyCleanup(raw, { mode: "scissors", commentChar: "#", nonEditorSource: true }))
			.toBe(`feat: x\n${scissors}\nbody`);
	});
});

// ---------------------------------------------------------------------------
// custom comment characters
// ---------------------------------------------------------------------------

describe("applyCleanup — custom commentChar", () => {
	it("strip with pipe as comment character", () => {
		const raw = "subject\n| comment\nbody";
		expect(applyCleanup(raw, { mode: "strip", commentChar: "|", nonEditorSource: false }))
			.toBe("subject\nbody");
	});

	it("strip with percent as comment character", () => {
		const raw = "subject\n% comment\nbody";
		expect(applyCleanup(raw, { mode: "strip", commentChar: "%", nonEditorSource: false }))
			.toBe("subject\nbody");
	});

	it("whitespace preserves pipe-prefixed lines", () => {
		const raw = "subject\n| still here\nbody";
		expect(applyCleanup(raw, { mode: "whitespace", commentChar: "|", nonEditorSource: true }))
			.toBe("subject\n| still here\nbody");
	});
});

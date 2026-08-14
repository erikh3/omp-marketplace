/**
 * Tests for ModeWidget — the below-editor mode/EX indicator.
 *
 * Theme stub: passthrough (`fg` returns the text unchanged) so `visibleWidth`
 * only sees the raw ANSI escape sequences baked by the widget itself.  The
 * widget wraps every label in `\x1b[7m…\x1b[27m`; visibleWidth strips those,
 * leaving only the printable label (e.g. " INSERT " = 9 visible chars).
 */
import { describe, expect, test } from "bun:test";
import { visibleWidth } from "@oh-my-pi/pi-tui";
import { ModeWidget } from "../../src/mode-widget.ts";
import type { Theme } from "@oh-my-pi/pi-coding-agent";

/** Passthrough theme stub — fg returns the text as-is. */
const theme: Theme = { fg: (_color: string, text: string) => text } as unknown as Theme;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function widget(mode: "normal" | "insert" | "visual" | "visual-line" = "insert") {
	return new ModeWidget(mode, theme);
}

// ---------------------------------------------------------------------------
// Mode labels
// ---------------------------------------------------------------------------

describe("ModeWidget — mode labels", () => {
	test("INSERT mode renders ' INSERT ' label", () => {
		const w = widget("insert");
		const line = w.render(20)[0] ?? "";
		expect(line.includes(" INSERT ")).toBe(true);
	});

	test("NORMAL mode renders ' NORMAL ' label", () => {
		const w = widget("normal");
		const line = w.render(20)[0] ?? "";
		expect(line.includes(" NORMAL ")).toBe(true);
	});

	test("VISUAL mode renders ' VISUAL ' label", () => {
		const w = widget("visual");
		const line = w.render(20)[0] ?? "";
		expect(line.includes(" VISUAL ")).toBe(true);
	});

	test("visual-line mode renders ' V-LINE ' label", () => {
		const w = widget("visual-line");
		const line = w.render(20)[0] ?? "";
		expect(line.includes(" V-LINE ")).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Right-alignment / padding
// ---------------------------------------------------------------------------

describe("ModeWidget — right-alignment", () => {
	// The widget pads with spaces so that visibleWidth(entireLine) === width.
	// With a passthrough theme the ANSI reversal escapes (\x1b[7m…\x1b[27m)
	// are the only invisible bytes; visibleWidth strips them correctly.

	test("render fills the full requested width (w=20)", () => {
		const w = widget("insert");
		const line = w.render(20)[0] ?? "";
		expect(visibleWidth(line)).toBe(20);
	});

	test("render fills the full requested width (w=40)", () => {
		const w = widget("insert");
		const line = w.render(40)[0] ?? "";
		expect(visibleWidth(line)).toBe(40);
	});

	test("label sits at the right edge — line starts with spaces", () => {
		// " INSERT " is 9 visible chars; width 20 → 11 leading spaces.
		const w = widget("insert");
		const line = w.render(20)[0] ?? "";
		expect(line.startsWith("  ")).toBe(true);
		// The trailing part (styled label) has no trailing spaces after it in the
		// raw string — but the overall visibleWidth must still equal the width.
		expect(visibleWidth(line)).toBe(20);
	});

	test("different width renders distinct left-pad", () => {
		const w = widget("normal");
		const line30 = w.render(30)[0] ?? "";
		const line20 = w.render(20)[0] ?? "";
		// Both fill their width.
		expect(visibleWidth(line30)).toBe(30);
		expect(visibleWidth(line20)).toBe(20);
		// The wider render has more leading spaces.
		const pad30 = (line30.match(/^ +/) ?? [""])[0].length;
		const pad20 = (line20.match(/^ +/) ?? [""])[0].length;
		expect(pad30).toBeGreaterThan(pad20);
	});

	test("render returns exactly one line", () => {
		const w = widget("normal");
		expect(w.render(20).length).toBe(1);
	});
});

// ---------------------------------------------------------------------------
// EX command display
// ---------------------------------------------------------------------------

describe("ModeWidget — EX command", () => {
	test("setExCommand shows 'EX :q_' in rendered line", () => {
		const w = widget("normal");
		w.setExCommand(":q");
		const line = w.render(20)[0] ?? "";
		// The EX label is formatted as ` EX <cmd>_ ` (with surrounding spaces).
		expect(line.includes("EX :q_")).toBe(true);
	});

	test("EX label takes precedence over mode label", () => {
		const w = widget("normal");
		w.setExCommand(":wq");
		const line = w.render(20)[0] ?? "";
		expect(line.includes("EX")).toBe(true);
		expect(line.includes("NORMAL")).toBe(false);
	});

	test("setExCommand(null) reverts to mode label", () => {
		const w = widget("normal");
		w.setExCommand(":q");
		w.setExCommand(null);
		const line = w.render(20)[0] ?? "";
		expect(line.includes("NORMAL")).toBe(true);
		expect(line.includes("EX")).toBe(false);
	});

	test("EX line is also right-aligned to fill the width", () => {
		const w = widget("normal");
		w.setExCommand(":q");
		const line = w.render(20)[0] ?? "";
		expect(visibleWidth(line)).toBe(20);
	});
});

// ---------------------------------------------------------------------------
// Cache behaviour
// ---------------------------------------------------------------------------

describe("ModeWidget — render cache", () => {
	test("repeated render(sameWidth) returns the same array reference", () => {
		const w = widget("insert");
		const first = w.render(20);
		const second = w.render(20);
		// Strict reference equality — the cached array is reused.
		expect(second).toBe(first);
	});

	test("render with a different width returns a new array", () => {
		const w = widget("insert");
		const a = w.render(20);
		const b = w.render(30);
		expect(b).not.toBe(a);
	});

	test("setMode invalidates the cache — output changes", () => {
		const w = widget("insert");
		const before = w.render(20)[0] ?? "";
		w.setMode("normal");
		const after = w.render(20)[0] ?? "";
		expect(after).not.toBe(before);
		expect(after.includes("NORMAL")).toBe(true);
	});

	test("setMode to the same value does NOT invalidate — same reference", () => {
		const w = widget("insert");
		const first = w.render(20);
		w.setMode("insert"); // no-op per implementation
		const second = w.render(20);
		expect(second).toBe(first);
	});

	test("setExCommand invalidates the cache", () => {
		const w = widget("normal");
		const before = w.render(20);
		w.setExCommand(":q");
		const after = w.render(20);
		expect(after).not.toBe(before);
	});

	test("setExCommand to the same value does NOT invalidate — same reference", () => {
		const w = widget("normal");
		w.setExCommand(":q");
		const first = w.render(20);
		w.setExCommand(":q"); // same value → no-op
		const second = w.render(20);
		expect(second).toBe(first);
	});

	test("invalidate() breaks the cache — render returns a new array", () => {
		const w = widget("insert");
		const first = w.render(20);
		w.invalidate();
		const second = w.render(20);
		// The content is identical but it must be a fresh array (re-rendered).
		expect(second).not.toBe(first);
		// Content is still correct after re-render.
		expect((second[0] ?? "").includes(" INSERT ")).toBe(true);
	});
});

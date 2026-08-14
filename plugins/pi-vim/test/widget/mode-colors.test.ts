/**
 * test/widget/mode-colors.test.ts
 *
 * ModeWidget must accept an injected per-mode color map (from pi-vim.json's
 * `modeColors`) instead of hardcoding the palette. A recording theme stub
 * captures which color token the widget passed to `theme.fg`, so we assert the
 * configured token is used per mode (and the EX line uses the ex token).
 */

import { describe, expect, test } from "bun:test";
import type { Theme, ThemeColor } from "@oh-my-pi/pi-coding-agent";
import { ModeWidget, type ModeColorMap } from "../../src/mode-widget.ts";

/** Theme stub that records the last color token passed to fg(). */
function recordingTheme(): { theme: Theme; lastColor: () => string | undefined } {
	let last: string | undefined;
	const theme = {
		fg: (color: string, text: string) => {
			last = color;
			return text;
		},
	} as unknown as Theme;
	return { theme, lastColor: () => last };
}

const CUSTOM: ModeColorMap = {
	normal: "success",
	insert: "dim",
	visual: "error",
	ex: "accent",
};

describe("ModeWidget — configurable modeColors", () => {
	test("NORMAL uses the configured normal color", () => {
		const { theme, lastColor } = recordingTheme();
		const w = new ModeWidget("normal", theme, CUSTOM);
		w.render(20);
		expect(lastColor()).toBe("success");
	});

	test("INSERT uses the configured insert color", () => {
		const { theme, lastColor } = recordingTheme();
		const w = new ModeWidget("insert", theme, CUSTOM);
		w.render(20);
		expect(lastColor()).toBe("dim");
	});

	test("VISUAL and V-LINE both use the configured visual color", () => {
		const { theme, lastColor } = recordingTheme();
		const wv = new ModeWidget("visual", theme, CUSTOM);
		wv.render(20);
		expect(lastColor()).toBe("error");

		const wl = new ModeWidget("visual-line", theme, CUSTOM);
		wl.render(20);
		expect(lastColor()).toBe("error");
	});

	test("EX line uses the configured ex color regardless of underlying mode", () => {
		const { theme, lastColor } = recordingTheme();
		const w = new ModeWidget("normal", theme, CUSTOM);
		w.setExCommand(":q");
		w.render(20);
		expect(lastColor()).toBe("accent");
	});

	test("omitting the color map falls back to the default palette", () => {
		const { theme, lastColor } = recordingTheme();
		const w = new ModeWidget("normal", theme); // no color map
		w.render(20);
		expect(lastColor()).toBe("borderAccent" satisfies ThemeColor);
	});
});

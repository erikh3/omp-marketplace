/**
 * test/host/config.test.ts
 *
 * Contract for pi-vim's dedicated JSON config loader. omp's Settings is a
 * closed typed schema with no `piVim.*` namespace, so pi-vim reads its own
 * `pi-vim.json`: a global file in the agent dir, overlaid by a project
 * `.omp/pi-vim.json`. All keys optional; missing/invalid falls back to the
 * documented defaults; the project layer overrides the global per top-level key.
 *
 * The loader takes an injected `readFile(path): string | null` so tests drive
 * it without touching disk.
 */

import { describe, expect, test } from "bun:test";
import {
	loadPiVimConfig,
	DEFAULT_CONFIG,
	type PiVimConfig,
} from "../../src/host/config.ts";

const AGENT = "/agent";
const CWD = "/proj";
const GLOBAL = `${AGENT}/pi-vim.json`;
const PROJECT = `${CWD}/.omp/pi-vim.json`;

/** Build a readFile stub from a path→contents map. */
function reader(files: Record<string, string>): (path: string) => string | null {
	return (path: string) => files[path] ?? null;
}

describe("defaults", () => {
	test("no files → full defaults", () => {
		const cfg = loadPiVimConfig(AGENT, CWD, reader({}));
		expect(cfg).toEqual(DEFAULT_CONFIG);
	});

	test("DEFAULT_CONFIG matches the documented baseline", () => {
		expect(DEFAULT_CONFIG.clipboardMirror).toBe("all");
		expect(DEFAULT_CONFIG.exCommand.piDispatch).toBe(true);
		expect(DEFAULT_CONFIG.exCommand.copyInputToClipboard).toBe(false);
		expect(DEFAULT_CONFIG.modeColors.normal).toBe("borderAccent");
		expect(DEFAULT_CONFIG.modeColors.insert).toBe("borderMuted");
		expect(DEFAULT_CONFIG.modeColors.visual).toBe("customMessageLabel");
		expect(DEFAULT_CONFIG.modeColors.ex).toBe("warning");
		expect(DEFAULT_CONFIG.labelSync.normal).toBe("mode");
		expect(DEFAULT_CONFIG.modeChange.insert).toBeUndefined();
		expect(DEFAULT_CONFIG.modeChange.normal).toBeUndefined();
	});
});

describe("global file", () => {
	test("reads clipboardMirror from the global file", () => {
		const cfg = loadPiVimConfig(
			AGENT,
			CWD,
			reader({ [GLOBAL]: JSON.stringify({ clipboardMirror: "yank" }) }),
		);
		expect(cfg.clipboardMirror).toBe("yank");
	});

	test("partial global merges over defaults (unspecified keys keep defaults)", () => {
		const cfg = loadPiVimConfig(
			AGENT,
			CWD,
			reader({ [GLOBAL]: JSON.stringify({ modeColors: { normal: "accent" } }) }),
		);
		expect(cfg.modeColors.normal).toBe("accent");
		expect(cfg.modeColors.insert).toBe("borderMuted"); // default retained
	});

	test("modeChange hooks are read from the global file", () => {
		const cfg = loadPiVimConfig(
			AGENT,
			CWD,
			reader({
				[GLOBAL]: JSON.stringify({
					modeChange: { insert: "im-select A", normal: "im-select B" },
				}),
			}),
		);
		expect(cfg.modeChange.insert).toBe("im-select A");
		expect(cfg.modeChange.normal).toBe("im-select B");
	});
});

describe("project overlay", () => {
	test("project overrides the global for clipboardMirror", () => {
		const cfg = loadPiVimConfig(
			AGENT,
			CWD,
			reader({
				[GLOBAL]: JSON.stringify({ clipboardMirror: "yank" }),
				[PROJECT]: JSON.stringify({ clipboardMirror: "never" }),
			}),
		);
		expect(cfg.clipboardMirror).toBe("never");
	});

	test("project-only key applies over global default", () => {
		const cfg = loadPiVimConfig(
			AGENT,
			CWD,
			reader({ [PROJECT]: JSON.stringify({ exCommand: { piDispatch: false } }) }),
		);
		expect(cfg.exCommand.piDispatch).toBe(false);
	});

	test("modeChange is user-global only — project modeChange is ignored", () => {
		const cfg = loadPiVimConfig(
			AGENT,
			CWD,
			reader({
				[GLOBAL]: JSON.stringify({ modeChange: { insert: "global-hook" } }),
				[PROJECT]: JSON.stringify({ modeChange: { insert: "project-hook" } }),
			}),
		);
		// Arbitrary-shell hooks must never be enabled by a checked-in project file.
		expect(cfg.modeChange.insert).toBe("global-hook");
	});

	test("copyInputToClipboard is user-global only — project value ignored", () => {
		const cfg = loadPiVimConfig(
			AGENT,
			CWD,
			reader({
				[GLOBAL]: JSON.stringify({ exCommand: { copyInputToClipboard: false } }),
				[PROJECT]: JSON.stringify({ exCommand: { copyInputToClipboard: true } }),
			}),
		);
		expect(cfg.exCommand.copyInputToClipboard).toBe(false);
	});
});

describe("robustness", () => {
	test("malformed JSON falls back to defaults without throwing", () => {
		const cfg = loadPiVimConfig(AGENT, CWD, reader({ [GLOBAL]: "{ not json" }));
		expect(cfg).toEqual(DEFAULT_CONFIG);
	});

	test("unknown clipboardMirror value falls back to the default", () => {
		const cfg = loadPiVimConfig(
			AGENT,
			CWD,
			reader({ [GLOBAL]: JSON.stringify({ clipboardMirror: "bogus" }) }),
		);
		expect(cfg.clipboardMirror).toBe("all");
	});

	test("non-object top-level JSON falls back to defaults", () => {
		const cfg = loadPiVimConfig(AGENT, CWD, reader({ [GLOBAL]: "42" }));
		expect(cfg).toEqual(DEFAULT_CONFIG);
	});

	test("returned config is a complete PiVimConfig (no undefined required keys)", () => {
		const cfg: PiVimConfig = loadPiVimConfig(AGENT, CWD, reader({}));
		expect(typeof cfg.clipboardMirror).toBe("string");
		expect(typeof cfg.exCommand.piDispatch).toBe("boolean");
		expect(typeof cfg.modeColors.normal).toBe("string");
		expect(typeof cfg.labelSync.normal).toBe("string");
	});
});

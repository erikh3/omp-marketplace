/**
 * test/host/mode-effects.test.ts
 *
 * Contract for the mode-change side effects wired by the extension:
 *   1. Every actual transition emits `pi-vim:mode-change` on `pi.events` with
 *      `{ mode, previousMode }` so other extensions can react.
 *   2. Entering INSERT runs the configured `modeChange.insert` shell hook;
 *      entering any non-insert editing mode (normal / visual / visual-line)
 *      runs `modeChange.normal`. Hooks run via `pi.exec` (fire-and-forget);
 *      a missing hook command runs nothing.
 *
 * The unit is `makeModeChangeHandler(pi, config)` → `(mode, previousMode)`,
 * driven with a fake ExtensionAPI so it is deterministic and offline.
 */

import { describe, expect, test } from "bun:test";
import { makeModeChangeHandler } from "../../src/host/mode-effects.ts";
import { DEFAULT_CONFIG, type PiVimConfig } from "../../src/host/config.ts";
import type { VimMode } from "../../src/modal-editor.ts";

interface EmitCall {
	channel: string;
	data: unknown;
}
interface ExecCall {
	command: string;
	args: string[];
}

/** Minimal fake ExtensionAPI recording events + exec. */
function fakePi() {
	const emits: EmitCall[] = [];
	const execs: ExecCall[] = [];
	const pi = {
		events: { emit: (channel: string, data: unknown) => emits.push({ channel, data }) },
		exec: async (command: string, args: string[]) => {
			execs.push({ command, args });
			return { code: 0, stdout: "", stderr: "" };
		},
	};
	return { pi, emits, execs };
}

function cfg(overrides: Partial<PiVimConfig["modeChange"]>): PiVimConfig {
	return { ...DEFAULT_CONFIG, modeChange: { ...DEFAULT_CONFIG.modeChange, ...overrides } };
}

describe("pi-vim:mode-change event", () => {
	test("emits on every transition with mode + previousMode", () => {
		const { pi, emits } = fakePi();
		const onMode = makeModeChangeHandler(pi as never, DEFAULT_CONFIG);
		onMode("normal", "insert");
		expect(emits).toHaveLength(1);
		expect(emits[0]?.channel).toBe("pi-vim:mode-change");
		expect(emits[0]?.data).toEqual({ mode: "normal", previousMode: "insert" });
	});

	test("emits for each subsequent transition", () => {
		const { pi, emits } = fakePi();
		const onMode = makeModeChangeHandler(pi as never, DEFAULT_CONFIG);
		onMode("normal", "insert");
		onMode("insert", "normal");
		onMode("visual", "insert");
		expect(emits.map((e) => (e.data as { mode: VimMode }).mode)).toEqual([
			"normal",
			"insert",
			"visual",
		]);
	});
});

describe("modeChange shell hooks", () => {
	test("entering INSERT runs the insert hook via pi.exec", () => {
		const { pi, execs } = fakePi();
		const onMode = makeModeChangeHandler(pi as never, cfg({ insert: "im-select ins" }));
		onMode("insert", "normal");
		expect(execs).toHaveLength(1);
		// Runs through a shell so the whole command string is honored.
		expect(execs[0]?.args.at(-1)).toContain("im-select ins");
	});

	test("entering NORMAL runs the normal hook", () => {
		const { pi, execs } = fakePi();
		const onMode = makeModeChangeHandler(pi as never, cfg({ normal: "im-select nrm" }));
		onMode("normal", "insert");
		expect(execs).toHaveLength(1);
		expect(execs[0]?.args.at(-1)).toContain("im-select nrm");
	});

	test("entering VISUAL and V-LINE both run the normal hook", () => {
		const { pi, execs } = fakePi();
		const onMode = makeModeChangeHandler(pi as never, cfg({ normal: "nrm" }));
		onMode("visual", "insert");
		onMode("visual-line", "insert");
		expect(execs).toHaveLength(2);
	});

	test("no hook configured → pi.exec is never called", () => {
		const { pi, execs } = fakePi();
		const onMode = makeModeChangeHandler(pi as never, DEFAULT_CONFIG);
		onMode("insert", "normal");
		onMode("normal", "insert");
		expect(execs).toHaveLength(0);
	});

	test("insert hook does not fire when entering a non-insert mode", () => {
		const { pi, execs } = fakePi();
		const onMode = makeModeChangeHandler(pi as never, cfg({ insert: "ins" }));
		onMode("normal", "insert");
		expect(execs).toHaveLength(0);
	});
});

/**
 * pi-vim's dedicated JSON configuration.
 *
 * omp's `Settings` is a closed, typed schema with no `piVim.*` namespace, so
 * pi-vim reads its own `pi-vim.json`: a global file in the agent dir, overlaid
 * by a project `.omp/pi-vim.json`. All keys are optional; a missing, malformed,
 * or unknown value falls back to the documented default (never throws). The
 * project layer overrides the global per top-level key, EXCEPT for two
 * arbitrary-power settings that are user-global only and ignored in a
 * project file:
 *   - `modeChange.*`                  (runs arbitrary shell on mode change)
 *   - `exCommand.copyInputToClipboard` (writes the prompt to the OS clipboard)
 *
 * `borderSync` from upstream lajarre/pi-vim is intentionally omitted: omp's
 * extension UI exposes no per-mode editor-border color seam.
 */

import { readFileSync } from "node:fs";
import type { ThemeColor } from "@oh-my-pi/pi-coding-agent";
import type { ClipboardMirror } from "../engine/registers.js";

/** Per-mode footer-label paint policy: the mode's own color, or the host's. */
export type LabelSyncMode = "mode" | "host";

/** Theme foreground tokens per mode for the footer indicator + EX line. */
export interface ModeColorConfig {
	normal: ThemeColor;
	insert: ThemeColor;
	visual: ThemeColor;
	ex: ThemeColor;
}

export interface LabelSyncConfig {
	normal: LabelSyncMode;
	insert: LabelSyncMode;
	visual: LabelSyncMode;
	ex: LabelSyncMode;
}

export interface ExCommandConfig {
	/** Whether the ex line dispatches Pi slash commands (`false` = quit-only). */
	piDispatch: boolean;
	/** Copy the composed prompt to the OS clipboard before each ex dispatch. */
	copyInputToClipboard: boolean;
}

export interface ModeChangeConfig {
	/** Shell command run on every transition into INSERT. */
	insert?: string;
	/** Shell command run on every transition into a non-INSERT editing mode. */
	normal?: string;
}

export interface PiVimConfig {
	clipboardMirror: ClipboardMirror;
	exCommand: ExCommandConfig;
	modeColors: ModeColorConfig;
	labelSync: LabelSyncConfig;
	modeChange: ModeChangeConfig;
}

/** The documented baseline, used whenever a key is missing or invalid. */
export const DEFAULT_CONFIG: PiVimConfig = {
	clipboardMirror: "all",
	exCommand: { piDispatch: true, copyInputToClipboard: false },
	modeColors: {
		normal: "borderAccent",
		insert: "borderMuted",
		visual: "customMessageLabel",
		ex: "warning",
	},
	labelSync: { normal: "mode", insert: "mode", visual: "mode", ex: "mode" },
	modeChange: {},
};

const CLIPBOARD_MIRRORS: readonly ClipboardMirror[] = ["all", "yank", "never"];
const LABEL_SYNCS: readonly LabelSyncMode[] = ["mode", "host"];

type Json = Record<string, unknown>;

/** Parse `path`'s JSON into a plain object, or null when absent/malformed. */
function parseFile(readFile: (path: string) => string | null, path: string): Json | null {
	const raw = readFile(path);
	if (raw === null) return null;
	try {
		const parsed: unknown = JSON.parse(raw);
		if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
		return parsed as Json;
	} catch {
		return null;
	}
}

function pickEnum<T extends string>(
	value: unknown,
	allowed: readonly T[],
	fallback: T,
): T {
	return typeof value === "string" && (allowed as readonly string[]).includes(value)
		? (value as T)
		: fallback;
}

function pickString(value: unknown, fallback: string): string {
	return typeof value === "string" ? value : fallback;
}

function pickBool(value: unknown, fallback: boolean): boolean {
	return typeof value === "boolean" ? value : fallback;
}

function asObject(value: unknown): Json {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Json)
		: {};
}

/**
 * Load the effective pi-vim config: global `<agentDir>/pi-vim.json` overlaid by
 * project `<cwd>/.omp/pi-vim.json`. `readFile` is injectable for tests; the
 * default reads from disk and returns null on any error.
 */
export function loadPiVimConfig(
	agentDir: string,
	cwd: string,
	readFile: (path: string) => string | null = defaultReadFile,
): PiVimConfig {
	const global = parseFile(readFile, `${agentDir}/pi-vim.json`) ?? {};
	const project = parseFile(readFile, `${cwd}/.omp/pi-vim.json`) ?? {};

	// Project overrides global for a shared key; global-only keys ignore project.
	const merged = (key: string): unknown => project[key] ?? global[key];

	const modeColors = { ...asObject(global.modeColors), ...asObject(project.modeColors) };
	const labelSync = { ...asObject(global.labelSync), ...asObject(project.labelSync) };
	const exGlobal = asObject(global.exCommand);
	const exProject = asObject(project.exCommand);

	return {
		clipboardMirror: pickEnum(merged("clipboardMirror"), CLIPBOARD_MIRRORS, DEFAULT_CONFIG.clipboardMirror),
		exCommand: {
			// piDispatch is project-overridable; copyInputToClipboard is global-only.
			piDispatch: pickBool(exProject.piDispatch ?? exGlobal.piDispatch, DEFAULT_CONFIG.exCommand.piDispatch),
			copyInputToClipboard: pickBool(exGlobal.copyInputToClipboard, DEFAULT_CONFIG.exCommand.copyInputToClipboard),
		},
		modeColors: {
			normal: pickString(modeColors.normal, DEFAULT_CONFIG.modeColors.normal) as ThemeColor,
			insert: pickString(modeColors.insert, DEFAULT_CONFIG.modeColors.insert) as ThemeColor,
			visual: pickString(modeColors.visual, DEFAULT_CONFIG.modeColors.visual) as ThemeColor,
			ex: pickString(modeColors.ex, DEFAULT_CONFIG.modeColors.ex) as ThemeColor,
		},
		labelSync: {
			normal: pickEnum(labelSync.normal, LABEL_SYNCS, DEFAULT_CONFIG.labelSync.normal),
			insert: pickEnum(labelSync.insert, LABEL_SYNCS, DEFAULT_CONFIG.labelSync.insert),
			visual: pickEnum(labelSync.visual, LABEL_SYNCS, DEFAULT_CONFIG.labelSync.visual),
			ex: pickEnum(labelSync.ex, LABEL_SYNCS, DEFAULT_CONFIG.labelSync.ex),
		},
		// modeChange is user-global only (arbitrary shell); a project file cannot set it.
		modeChange: {
			insert: typeof asObject(global.modeChange).insert === "string" ? (asObject(global.modeChange).insert as string) : undefined,
			normal: typeof asObject(global.modeChange).normal === "string" ? (asObject(global.modeChange).normal as string) : undefined,
		},
	};
}

/** Default disk reader: returns file contents or null on any error. */
function defaultReadFile(path: string): string | null {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return null;
	}
}

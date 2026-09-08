/**
 * Configuration loader for git-commit-linter.
 *
 * Detects repository commitlint config via cosmiconfig, loads it through
 * @commitlint/load, merges plugin JSONC user and project configs, and
 * returns a single EffectiveLintConfig (or a failure discriminant).
 *
 * Reloads from disk on every call; no cross-call cache.
 */

import { getAgentDir } from "@oh-my-pi/pi-coding-agent";
import load from "@commitlint/load";
import conventionalConfig from "@commitlint/config-conventional";
import createConventionalPreset from "conventional-changelog-conventionalcommits";
import type { UserConfig, QualifiedConfig } from "@commitlint/types";
import { cosmiconfig } from "cosmiconfig";
import { TypeScriptLoader } from "cosmiconfig-typescript-loader";
import { parse as parseJsonc, type ParseError } from "jsonc-parser";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type {
	ConfigLoadResult,
	GitCommitLinterBehavior,
} from "./types.ts";

interface ConventionalPreset {
	readonly parser: unknown;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Build the bundled default without dynamic package resolution under OMP. */
async function conventionalSeed(): Promise<UserConfig> {
	const preset = await createConventionalPreset() as ConventionalPreset;
	return {
		...conventionalConfig,
		parserPreset: {
			name: "conventional-changelog-conventionalcommits",
			parserOpts: preset.parser,
		},
	};
}

/**
 * Standard commitlint cosmiconfig search places — must match what
 * @commitlint/load uses internally so detection and loading agree.
 */
const COMMITLINT_SEARCH_PLACES = [
	"package.json",
	".commitlintrc",
	".commitlintrc.json",
	".commitlintrc.yaml",
	".commitlintrc.yml",
	".commitlintrc.js",
	".commitlintrc.ts",
	".commitlintrc.cjs",
	".commitlintrc.mjs",
	".config/commitlintrc",
	".config/commitlintrc.json",
	".config/commitlintrc.yaml",
	".config/commitlintrc.yml",
	".config/commitlintrc.js",
	".config/commitlintrc.ts",
	".config/commitlintrc.cjs",
	".config/commitlintrc.mjs",
	"commitlint.config.js",
	"commitlint.config.ts",
	"commitlint.config.cjs",
	"commitlint.config.mjs",
];

/** Plugin JSONC filename, shared between user and project locations. */
const PLUGIN_CONFIG_FILENAME = "git-commit-linter.jsonc";

/**
 * Serializable commitlint fields allowed in plugin JSONC.
 * Function-valued fields (ignores, local plugins, async rule factories) are
 * not serializable and are rejected.
 */
const ALLOWED_JSONC_FIELDS: Record<string, true> = {
	extends: true,
	rules: true,
	parserPreset: true,
	defaultIgnores: true,
	formatter: true,
	helpUrl: true,
	plugins: true,
};

/**
 * Commitlint fields that require executable shapes JSONC cannot represent.
 * Detecting these by name lets us give a clear error.
 */
const EXECUTABLE_JSONC_FIELDS: Record<string, true> = {
	ignores: true,
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Load and merge configuration for one Git worktree root.
 *
 * Resolution order when no repository config is present:
 *   1. Conventional Commits seed.
 *   2. User plugin JSONC (~/.omp/agent/git-commit-linter.jsonc).
 *   3. Project plugin JSONC (<root>/.omp/git-commit-linter.jsonc).
 *
 * When a repository config is present, it replaces only lint policy (the
 * commitlint QualifiedConfig). Plugin behavior is loaded separately and
 * preserved.
 */
export async function loadConfig(repoRoot: string): Promise<ConfigLoadResult> {
	// Step 1: Load plugin JSONC configs (user then project). Fatal on error.
	let pluginResult: PluginJsoncResult;
	try {
		pluginResult = loadPluginJsonc(repoRoot);
	} catch (error) {
		return { kind: "fatal", error };
	}

	// Step 2: Detect whether a repository commitlint config exists.
	let repoConfigFound: boolean;
	try {
		repoConfigFound = await detectRepoConfig(repoRoot);
	} catch (error) {
		// Detection failure is treated as broken-repository-config (fail-open).
		return { kind: "broken-repository-config", error };
	}

	// Step 3a: Repository config detected — call load with empty seed so
	// @commitlint/load reads the repo file. Any load failure is
	// broken-repository-config (fail-open for the Bash call).
	if (repoConfigFound) {
		let repoQualified: QualifiedConfig;
		try {
			repoQualified = await load({}, { cwd: repoRoot });
		} catch (error) {
			return { kind: "broken-repository-config", error };
		}

		return {
			kind: "ready",
			config: {
				commitlint: repoQualified,
				gitCommitLinter: pluginResult.behavior,
			},
		};
	}

	// Step 3b: No repository config — merge seed + user plugin + project plugin.
	const seed = await conventionalSeed();
	const mergedSeed = mergeUserConfigs(seed, pluginResult.userConfig);
	let qualified: QualifiedConfig;
	try {
		qualified = await load(mergedSeed, { cwd: import.meta.dir });
	} catch (error) {
		return { kind: "fatal", error };
	}

	return {
		kind: "ready",
		config: {
			commitlint: qualified,
			gitCommitLinter: pluginResult.behavior,
		},
	};
}

// ---------------------------------------------------------------------------
// Repository config detection
// ---------------------------------------------------------------------------

/**
 * Check whether the repository root contains a commitlint config file.
 * Creates a fresh cosmiconfig explorer on every call (no cache).
 *
 * An empty config file (e.g. `{}`) is still a valid repository policy and is
 * treated as present. Only a missing file (null result) counts as absent.
 */
async function detectRepoConfig(repoRoot: string): Promise<boolean> {
	const explorer = cosmiconfig("commitlint", {
		searchPlaces: COMMITLINT_SEARCH_PLACES,
		loaders: {
			".ts": TypeScriptLoader(),
		},
		stopDir: repoRoot,
	});

	const result = await explorer.search(repoRoot);
	return result !== null;
}

// ---------------------------------------------------------------------------
// Plugin JSONC loading
// ---------------------------------------------------------------------------

interface PluginJsoncResult {
	/** Serializable commitlint fields from merged user + project JSONC. */
	readonly userConfig: UserConfig;
	/** Plugin behavior object. */
	readonly behavior: GitCommitLinterBehavior;
}

/**
 * Load and merge the user and project plugin JSONC configs.
 * Throws on any parse or validation error (fatal).
 */
function loadPluginJsonc(repoRoot: string): PluginJsoncResult {
	const userPath = join(getAgentDir(), PLUGIN_CONFIG_FILENAME);
	const projectPath = join(repoRoot, ".omp", PLUGIN_CONFIG_FILENAME);

	const userParsed = loadAndParseJsonc(userPath);
	const projectParsed = loadAndParseJsonc(projectPath);

	return {
		userConfig: mergeUserConfigs(
			userParsed?.commitlintFields ?? {},
			projectParsed?.commitlintFields ?? {},
		),
		behavior: {},
	};
}

interface ParsedJsoncFile {
	readonly commitlintFields: UserConfig;
	readonly behavior: GitCommitLinterBehavior;
}

/**
 * Load and parse a single plugin JSONC file.
 * Returns null when the file does not exist.
 * Throws on parse error, root-not-object, unknown keys, or executable shapes.
 */
function loadAndParseJsonc(filePath: string): ParsedJsoncFile | null {
	if (!existsSync(filePath)) return null;

	const text = readFileSync(filePath, "utf8");
	const errors: ParseError[] = [];
	const parsed: unknown = parseJsonc(text, errors, {
		allowTrailingComma: true,
		allowEmptyContent: false,
		disallowComments: false,
	});

	if (errors.length > 0) {
		const first = errors[0]!;
		throw new Error(
			`git-commit-linter: ${filePath}: JSONC parse error (code ${first.error}) at offset ${first.offset}`,
		);
	}

	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error(
			`git-commit-linter: ${filePath}: config root must be a JSON object`,
		);
	}

	const root = parsed as Record<string, unknown>;

	const commitlintFields: Record<string, unknown> = {};

	for (const [key, value] of Object.entries(root)) {
		if (key === "gitCommitLinter") {
			// Validate the behavior block: must be an object with no keys.
			if (value === null || typeof value !== "object" || Array.isArray(value)) {
				throw new Error(
					`git-commit-linter: ${filePath}: "gitCommitLinter" must be an object`,
				);
			}
			const unknownKeys = Object.keys(value as object);
			if (unknownKeys.length > 0) {
				throw new Error(
					`git-commit-linter: ${filePath}: "gitCommitLinter" has unknown keys: ${unknownKeys.join(", ")}`,
				);
			}
			continue;
		}

		if (EXECUTABLE_JSONC_FIELDS[key] === true) {
			throw new Error(
				`git-commit-linter: ${filePath}: field "${key}" requires executable functions and cannot appear in JSONC config. Use a repository commitlint config file instead.`,
			);
		}

		if (ALLOWED_JSONC_FIELDS[key] !== true) {
			throw new Error(
				`git-commit-linter: ${filePath}: unknown field "${key}". Supported serializable fields: ${Object.keys(ALLOWED_JSONC_FIELDS).join(", ")}`,
			);
		}

		commitlintFields[key] = value;
	}

	return {
		commitlintFields: commitlintFields as UserConfig,
		behavior: {},
	};
}

// ---------------------------------------------------------------------------
// Config merge helpers
// ---------------------------------------------------------------------------

/**
 * Merge two partial UserConfig objects.
 * `b` overwrites `a` for the same field. The `rules` field is merged
 * rule-by-rule so project rules override user rules per rule name without
 * dropping rules defined only in user config.
 */
function mergeUserConfigs(a: UserConfig, b: UserConfig): UserConfig {
	const merged: UserConfig = { ...a, ...b };

	if (a.rules !== undefined || b.rules !== undefined) {
		merged.rules = {
			...(a.rules ?? {}),
			...(b.rules ?? {}),
		};
	}

	return merged;
}

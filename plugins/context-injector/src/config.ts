import { getAgentDir } from "@oh-my-pi/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import type { ContextInjectorConfig, InjectionEntry } from "./types.ts";

const CONFIG_FILE = "context-injector.yml";

/**
 * Validate and coerce a raw parsed YAML value into ContextInjectorConfig.
 * Throws a descriptive error when the shape is wrong.
 */
function validateConfig(raw: unknown, sourcePath: string): ContextInjectorConfig {
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
		throw new Error(`context-injector: ${sourcePath}: root must be a YAML mapping`);
	}

	const root = raw as Record<string, unknown>;

	if (!Array.isArray(root["inject"])) {
		throw new Error(
			`context-injector: ${sourcePath}: missing or invalid 'inject' list`,
		);
	}

	const inject: InjectionEntry[] = root["inject"].map((item: unknown, idx: number) => {
		if (item === null || typeof item !== "object" || Array.isArray(item)) {
			throw new Error(
				`context-injector: ${sourcePath}: inject[${idx}] must be a mapping`,
			);
		}
		const entry = item as Record<string, unknown>;
		if (typeof entry["path"] !== "string" || !entry["path"].trim()) {
			throw new Error(
				`context-injector: ${sourcePath}: inject[${idx}].path must be a non-empty string`,
			);
		}
		return {
			path: entry["path"].trim(),
			...(typeof entry["label"] === "string" && { label: entry["label"] }),
			...(typeof entry["once"] === "boolean" && { once: entry["once"] }),
			...(typeof entry["display"] === "boolean" && { display: entry["display"] }),
		};
	});

	return { inject };
}

/**
 * Load and parse a context-injector.yml at `configPath`.
 * Returns null when the file does not exist.
 * Throws on parse or validation errors.
 */
export function loadConfig(configPath: string): ContextInjectorConfig | null {
	if (!existsSync(configPath)) return null;
	const raw = readFileSync(configPath, "utf8");
	const parsed = parseYaml(raw);
	return validateConfig(parsed, configPath);
}

/**
 * Load and merge configs from both locations. Project entries appear first,
 * preserving the documented order guarantee: config order = injection order.
 *
 * Project:  <cwd>/.omp/context-injector.yml
 * User:     ~/.omp/agent/context-injector.yml  (profile-aware via getAgentDir)
 */
export function loadMergedConfig(cwd: string): ContextInjectorConfig {
	const project = loadConfig(join(cwd, ".omp", CONFIG_FILE));
	const user = loadConfig(join(getAgentDir(), CONFIG_FILE));
	return { inject: [...(project?.inject ?? []), ...(user?.inject ?? [])] };
}

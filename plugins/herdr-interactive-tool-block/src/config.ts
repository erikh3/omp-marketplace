import { getPluginSettings } from "@oh-my-pi/pi-coding-agent/extensibility/plugins";

export const PLUGIN_NAME = "herdr-interactive-tool-block";

export interface BlockConfig {
	enabled: boolean;
	/**
	 * Sparse per-rule enablement override, keyed by rule id. A rule runs unless
	 * its entry is exactly `false`, so a newly dropped-in rule is enabled without
	 * any config change.
	 */
	rules: Record<string, boolean>;
	/**
	 * Interactive op names for the `browser-tools` rule. `undefined` lets that rule
	 * use its own defaults, so config stays rule-agnostic.
	 */
	browserToolsOps?: readonly string[];
}

export const DEFAULT_CONFIG: BlockConfig = {
	enabled: true,
	rules: {},
};

export function stringList(value: unknown): readonly string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const valid = value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
	return valid.length > 0 ? [...new Set(valid.map(entry => entry.trim()))] : undefined;
}

export function ruleToggles(value: unknown): Record<string, boolean> {
	const toggles: Record<string, boolean> = {};
	if (value && typeof value === "object" && !Array.isArray(value)) {
		for (const [id, flag] of Object.entries(value as Record<string, unknown>)) {
			if (typeof flag === "boolean") toggles[id] = flag;
		}
	}
	return toggles;
}

export async function loadConfig(cwd: string): Promise<BlockConfig> {
	const settings = await getPluginSettings(PLUGIN_NAME, cwd);
	return {
		enabled: settings["enabled"] !== false,
		rules: ruleToggles(settings["rules"]),
		browserToolsOps: stringList(settings["browserToolsOps"]),
	};
}

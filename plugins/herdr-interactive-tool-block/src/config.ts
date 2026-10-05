import { getPluginSettings } from "@oh-my-pi/pi-coding-agent/extensibility/plugins";

import { DEFAULT_TOOL_PATTERNS } from "./rules/interactive-tools.ts";

export const PLUGIN_NAME = "herdr-interactive-tool-block";

/** Rule ids that ship with the plugin, each toggleable from settings. */
export const RULE_IDS = ["interactive-tools", "difit", "plannotator"] as const;
export type RuleId = (typeof RULE_IDS)[number];

export interface BlockConfig {
	enabled: boolean;
	/** Per-rule enablement. A rule runs only when its entry is not `false`. */
	rules: Record<RuleId, boolean>;
	/** Tool-name substrings for the `interactive-tools` rule. */
	tools: readonly string[];
}

export const DEFAULT_CONFIG: BlockConfig = {
	enabled: true,
	rules: { "interactive-tools": true, difit: true, plannotator: true },
	tools: DEFAULT_TOOL_PATTERNS,
};

function toolPatterns(value: unknown): readonly string[] {
	if (!Array.isArray(value)) return DEFAULT_TOOL_PATTERNS;
	const valid = value.filter(
		(entry): entry is string => typeof entry === "string" && entry.trim().length > 0,
	);
	return valid.length > 0 ? [...new Set(valid.map(entry => entry.trim()))] : DEFAULT_TOOL_PATTERNS;
}

function ruleToggles(value: unknown): Record<RuleId, boolean> {
	const toggles = { ...DEFAULT_CONFIG.rules };
	if (value && typeof value === "object" && !Array.isArray(value)) {
		const raw = value as Record<string, unknown>;
		for (const id of RULE_IDS) {
			if (raw[id] === false) toggles[id] = false;
		}
	}
	return toggles;
}

export async function loadConfig(cwd: string): Promise<BlockConfig> {
	const settings = await getPluginSettings(PLUGIN_NAME, cwd);
	return {
		enabled: settings["enabled"] !== false,
		rules: ruleToggles(settings["rules"]),
		tools: toolPatterns(settings["tools"]),
	};
}

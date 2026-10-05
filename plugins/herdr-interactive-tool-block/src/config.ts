import { getPluginSettings } from "@oh-my-pi/pi-coding-agent/extensibility/plugins";

import { BROWSER_TOOLS_INTERACTIVE } from "./rules/browser-tools.ts";
import { RULE_IDS, type RuleId } from "./rules/index.ts";

export const PLUGIN_NAME = "herdr-interactive-tool-block";

export interface BlockConfig {
	enabled: boolean;
	/** Per-rule enablement. A rule runs only when its entry is not `false`. */
	rules: Record<RuleId, boolean>;
	/** Interactive op names for the `browser-tools` rule. */
	browserToolsOps: readonly string[];
}

function defaultRuleToggles(): Record<RuleId, boolean> {
	return Object.fromEntries(RULE_IDS.map(id => [id, true])) as Record<RuleId, boolean>;
}

export const DEFAULT_CONFIG: BlockConfig = {
	enabled: true,
	rules: defaultRuleToggles(),
	browserToolsOps: BROWSER_TOOLS_INTERACTIVE,
};

export function stringList(value: unknown, fallback: readonly string[]): readonly string[] {
	if (!Array.isArray(value)) return fallback;
	const valid = value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
	return valid.length > 0 ? [...new Set(valid.map(entry => entry.trim()))] : fallback;
}

export function ruleToggles(value: unknown): Record<RuleId, boolean> {
	const toggles = defaultRuleToggles();
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
		browserToolsOps: stringList(settings["browserToolsOps"], BROWSER_TOOLS_INTERACTIVE),
	};
}

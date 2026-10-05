import type { BlockConfig } from "../config.ts";
import { browserToolsRule } from "./browser-tools.ts";
import { difitRule } from "./difit.ts";
import { plannotatorRule } from "./plannotator.ts";
import type { BlockRule } from "./types.ts";

export type { BlockRule, ToolStartInfo } from "./types.ts";

/**
 * The rule registry: the single place a new rule is wired in. Add a module under
 * `src/rules/` and one entry here. Everything else (config toggles, defaults, load
 * order) derives from this map, so no other file needs editing.
 *
 * Each entry builds a fresh rule with its own private state from the resolved
 * config. A rule that needs no config ignores the argument.
 */
export const RULE_FACTORIES = {
	"browser-tools": (config: BlockConfig) => browserToolsRule(config.browserToolsOps),
	difit: () => difitRule(),
	plannotator: () => plannotatorRule(),
} satisfies Record<string, (config: BlockConfig) => BlockRule>;

export type RuleId = keyof typeof RULE_FACTORIES;

/** All built-in rule ids, in registry (and load) order. */
export const RULE_IDS = Object.keys(RULE_FACTORIES) as RuleId[];

/** Build the enabled rules in registry order from config. */
export function buildRules(config: BlockConfig): BlockRule[] {
	const rules: BlockRule[] = [];
	for (const id of RULE_IDS) {
		if (config.rules[id]) rules.push(RULE_FACTORIES[id](config));
	}
	return rules;
}

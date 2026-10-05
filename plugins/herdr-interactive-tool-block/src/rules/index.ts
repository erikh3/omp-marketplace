import type { BlockConfig, RuleId } from "../config.ts";
import { difitRule } from "./difit.ts";
import { interactiveToolsRule } from "./interactive-tools.ts";
import { plannotatorRule } from "./plannotator.ts";
import type { BlockRule } from "./types.ts";

export type { BlockRule, ToolStartInfo } from "./types.ts";

/** Factory per rule id. Each call builds a fresh rule with its own private state. */
const RULE_FACTORIES: Record<RuleId, (config: BlockConfig) => BlockRule> = {
	"interactive-tools": config => interactiveToolsRule(config.tools),
	difit: () => difitRule(),
	plannotator: () => plannotatorRule(),
};

/** Build the enabled rules in a stable order from config. */
export function buildRules(config: BlockConfig): BlockRule[] {
	const rules: BlockRule[] = [];
	for (const id of Object.keys(RULE_FACTORIES) as RuleId[]) {
		if (config.rules[id]) rules.push(RULE_FACTORIES[id](config));
	}
	return rules;
}

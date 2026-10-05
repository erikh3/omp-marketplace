import { describe, expect, test } from "bun:test";

import { DEFAULT_CONFIG, type BlockConfig } from "../../src/config.ts";
import { buildRules } from "../../src/rules/index.ts";

function configWith(overrides: Partial<BlockConfig>): BlockConfig {
	return { ...DEFAULT_CONFIG, ...overrides, rules: { ...DEFAULT_CONFIG.rules, ...overrides.rules } };
}

describe("buildRules", () => {
	test("builds all three built-in rules by default, in a stable order", () => {
		expect(buildRules(DEFAULT_CONFIG).map(rule => rule.id)).toEqual(["interactive-tools", "difit", "plannotator"]);
	});

	test("omits a rule whose toggle is false", () => {
		const config = configWith({ rules: { "interactive-tools": true, difit: false, plannotator: true } });
		expect(buildRules(config).map(rule => rule.id)).toEqual(["interactive-tools", "plannotator"]);
	});

	test("passes configured tool patterns into the interactive-tools rule", () => {
		const config = configWith({ tools: ["custom_confirm"] });
		const rule = buildRules(config).find(entry => entry.id === "interactive-tools");
		expect(rule?.onToolStart({ toolCallId: "c1", toolName: "mcp__custom_confirm", args: {}, intent: "Confirm" })).toBe("Confirm");
	});
});

import { describe, expect, test } from "bun:test";

import { DEFAULT_CONFIG, type BlockConfig } from "../../src/config.ts";
import { buildRules, RULE_IDS } from "../../src/rules/index.ts";

function configWith(overrides: Partial<BlockConfig>): BlockConfig {
	return { ...DEFAULT_CONFIG, ...overrides, rules: { ...DEFAULT_CONFIG.rules, ...overrides.rules } };
}

describe("registry", () => {
	test("exposes the built-in rule ids in registry order", () => {
		expect(RULE_IDS).toEqual(["browser-tools", "difit", "plannotator"]);
	});

	test("builds all enabled rules by default, in registry order", () => {
		expect(buildRules(DEFAULT_CONFIG).map(rule => rule.id)).toEqual(["browser-tools", "difit", "plannotator"]);
	});

	test("omits a rule whose toggle is false", () => {
		const config = configWith({ rules: { "browser-tools": true, difit: false, plannotator: true } });
		expect(buildRules(config).map(rule => rule.id)).toEqual(["browser-tools", "plannotator"]);
	});

	test("passes configured ops into the browser-tools rule", () => {
		const config = configWith({ browserToolsOps: ["hover"] });
		const rule = buildRules(config).find(entry => entry.id === "browser-tools");
		expect(rule?.onToolStart({ toolCallId: "c1", toolName: "mcp__browser_tools_hover", args: {}, intent: "Hover" })).toBe("Hover");
		expect(rule?.onToolStart({ toolCallId: "c2", toolName: "mcp__browser_tools_click", args: {}, intent: "Click" })).toBeUndefined();
	});
});

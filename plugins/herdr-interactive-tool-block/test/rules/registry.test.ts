import { describe, expect, test } from "bun:test";

import { DEFAULT_CONFIG, type BlockConfig } from "../../src/config.ts";
import { buildRules, discoverRuleFactories, instantiateRules, type RuleFactory } from "../../src/rules/index.ts";
import type { BlockRule } from "../../src/rules/types.ts";

function configWith(overrides: Partial<BlockConfig>): BlockConfig {
	return { ...DEFAULT_CONFIG, ...overrides, rules: { ...DEFAULT_CONFIG.rules, ...overrides.rules } };
}

function fixedRule(id: string): RuleFactory {
	return () => ({ id, onToolStart: () => undefined });
}

describe("discoverRuleFactories", () => {
	test("discovers every built-in rule by dropping each file in, no manual list", async () => {
		const factories = await discoverRuleFactories();
		const ids = factories.map(factory => factory(DEFAULT_CONFIG).id);
		expect(ids).toEqual(["browser-tools", "difit", "plannotator"]);
	});
});

describe("buildRules", () => {
	test("builds all built-in rules enabled by default, in directory order", async () => {
		const rules = await buildRules(DEFAULT_CONFIG);
		expect(rules.map(rule => rule.id)).toEqual(["browser-tools", "difit", "plannotator"]);
	});

	test("omits a rule whose toggle is false", async () => {
		const rules = await buildRules(configWith({ rules: { difit: false } }));
		expect(rules.map(rule => rule.id)).toEqual(["browser-tools", "plannotator"]);
	});
});

describe("instantiateRules", () => {
	test("a newly dropped-in rule is enabled without any config entry", () => {
		const rules = instantiateRules([fixedRule("brand-new")], DEFAULT_CONFIG);
		expect(rules.map(rule => rule.id)).toEqual(["brand-new"]);
	});

	test("skips a factory that returns a malformed rule, keeping the rest", () => {
		const warnings: string[] = [];
		const bad: RuleFactory = () => ({ id: "", onToolStart: () => undefined }) as BlockRule;
		const rules = instantiateRules([bad, fixedRule("good")], DEFAULT_CONFIG, msg => warnings.push(msg));
		expect(rules.map(rule => rule.id)).toEqual(["good"]);
		expect(warnings).toHaveLength(1);
	});

	test("skips a factory that throws, keeping the rest", () => {
		const warnings: string[] = [];
		const boom: RuleFactory = () => {
			throw new Error("boom");
		};
		const rules = instantiateRules([boom, fixedRule("good")], DEFAULT_CONFIG, msg => warnings.push(msg));
		expect(rules.map(rule => rule.id)).toEqual(["good"]);
		expect(warnings[0]).toContain("boom");
	});

	test("skips a duplicate id, keeping the first", () => {
		const warnings: string[] = [];
		const rules = instantiateRules([fixedRule("dup"), fixedRule("dup")], DEFAULT_CONFIG, msg => warnings.push(msg));
		expect(rules.map(rule => rule.id)).toEqual(["dup"]);
		expect(warnings.some(message => message.includes("duplicate"))).toBe(true);
	});

	test("passes configured ops into the browser-tools rule", async () => {
		const factories = await discoverRuleFactories();
		const rules = instantiateRules(factories, configWith({ browserToolsOps: ["hover"] }));
		const rule = rules.find(entry => entry.id === "browser-tools");
		expect(rule?.onToolStart({ toolCallId: "c1", toolName: "mcp__browser_tools_hover", args: {}, intent: "Hover" })).toBe("Hover");
		expect(rule?.onToolStart({ toolCallId: "c2", toolName: "mcp__browser_tools_click", args: {}, intent: "Click" })).toBeUndefined();
	});
});

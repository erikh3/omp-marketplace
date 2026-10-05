import type { BlockConfig } from "../config.ts";
import type { BlockRule } from "./types.ts";

export type { BlockRule, ToolStartInfo } from "./types.ts";

/**
 * A rule module's default export: builds a fresh rule (with its own private
 * state) from the resolved config. A rule that needs no config ignores the
 * argument. Every `*.ts` file in this directory except `index.ts` and `types.ts`
 * is treated as a rule module and must default-export one of these.
 */
export type RuleFactory = (config: BlockConfig) => BlockRule;

/** Non-rule files in this directory, skipped during discovery. */
const NON_RULE_FILES = new Set(["index.ts", "types.ts"]);

/** Optional sink for discovery/validation diagnostics. */
export type WarnFn = (message: string) => void;

function isBlockRule(value: unknown): value is BlockRule {
	return (
		!!value &&
		typeof value === "object" &&
		typeof (value as BlockRule).id === "string" &&
		(value as BlockRule).id.length > 0 &&
		typeof (value as BlockRule).onToolStart === "function"
	);
}

/**
 * Discover rule factories by importing every rule module in this directory. A
 * file whose default export is not a function is skipped with a warning, so one
 * malformed rule file never takes down the rest.
 */
export async function discoverRuleFactories(dir: string = import.meta.dir, onWarn?: WarnFn): Promise<RuleFactory[]> {
	const glob = new Bun.Glob("*.ts");
	const files = [...glob.scanSync({ cwd: dir })].filter(file => !NON_RULE_FILES.has(file) && !file.endsWith(".test.ts")).sort();
	const factories: RuleFactory[] = [];
	for (const file of files) {
		try {
			// Runtime registry: rule modules are discovered on disk, so the
			// specifier is not known at author time and must be dynamic.
			const mod: unknown = await import(`${dir}/${file}`);
			const factory = mod && typeof mod === "object" && "default" in mod ? mod.default : undefined;
			if (typeof factory !== "function") {
				onWarn?.(`rule module ${file} has no default-exported factory function; skipping`);
				continue;
			}
			factories.push(factory as RuleFactory);
		} catch (error) {
			onWarn?.(`failed to load rule module ${file}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	return factories;
}

/**
 * Instantiate the enabled rules from a set of factories. Pure: no filesystem
 * access. A factory that throws or returns a malformed rule is skipped with a
 * warning; a duplicate id is skipped; a rule disabled in config is omitted.
 */
export function instantiateRules(factories: readonly RuleFactory[], config: BlockConfig, onWarn?: WarnFn): BlockRule[] {
	const rules: BlockRule[] = [];
	const seen = new Set<string>();
	for (const factory of factories) {
		let rule: BlockRule;
		try {
			rule = factory(config);
		} catch (error) {
			onWarn?.(`rule factory threw during construction: ${error instanceof Error ? error.message : String(error)}`);
			continue;
		}
		if (!isBlockRule(rule)) {
			onWarn?.("rule factory returned a value without a string id and onToolStart; skipping");
			continue;
		}
		if (seen.has(rule.id)) {
			onWarn?.(`duplicate rule id "${rule.id}"; skipping the later one`);
			continue;
		}
		seen.add(rule.id);
		if (config.rules[rule.id] !== false) rules.push(rule);
	}
	return rules;
}

/** Discover and instantiate the enabled rules in directory (alphabetical) order. */
export async function buildRules(config: BlockConfig, onWarn?: WarnFn): Promise<BlockRule[]> {
	return instantiateRules(await discoverRuleFactories(import.meta.dir, onWarn), config, onWarn);
}

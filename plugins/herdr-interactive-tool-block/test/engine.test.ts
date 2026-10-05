import { describe, expect, test } from "bun:test";

import { BlockEngine } from "../src/engine.ts";
import type { BlockRule, ToolStartInfo } from "../src/rules/types.ts";

interface Signal {
	active: boolean;
	label?: string;
}

function labelRule(id: string, match: string, label: string): BlockRule {
	return {
		id,
		onToolStart: event => (event.toolName === match ? label : undefined),
	};
}

function start(toolCallId: string, toolName: string): ToolStartInfo {
	return { toolCallId, toolName, args: {} };
}

function makeEngine(rules: BlockRule[]) {
	const signals: Signal[] = [];
	const engine = new BlockEngine(rules, (active, label) => signals.push({ active, label }));
	return { engine, signals };
}

describe("BlockEngine lifecycle", () => {
	test("emits active then inactive around a matched call", () => {
		const { engine, signals } = makeEngine([labelRule("a", "click", "Clicking")]);
		engine.onToolStart(start("call-1", "click"));
		engine.onToolEnd("call-1");
		expect(signals).toEqual([
			{ active: true, label: "Clicking" },
			{ active: false, label: undefined },
		]);
	});

	test("emits nothing when no rule matches", () => {
		const { engine, signals } = makeEngine([labelRule("a", "click", "Clicking")]);
		engine.onToolStart(start("call-1", "navigate"));
		engine.onToolEnd("call-1");
		expect(signals).toEqual([]);
		expect(engine.openCount).toBe(0);
	});

	test("ignores an end for an untracked call id", () => {
		const { engine, signals } = makeEngine([labelRule("a", "click", "Clicking")]);
		engine.onToolStart(start("call-1", "click"));
		engine.onToolEnd("other");
		expect(signals).toHaveLength(1);
		expect(engine.openCount).toBe(1);
	});

	test("brackets two overlapping calls independently", () => {
		const { engine, signals } = makeEngine([labelRule("a", "click", "Clicking"), labelRule("b", "type", "Typing")]);
		engine.onToolStart(start("call-1", "click"));
		engine.onToolStart(start("call-2", "type"));
		engine.onToolEnd("call-1");
		engine.onToolEnd("call-2");
		expect(signals.map(s => s.active)).toEqual([true, true, false, false]);
		expect(signals[0]?.label).toBe("Clicking");
		expect(signals[1]?.label).toBe("Typing");
	});

	test("first matching rule's label wins for a single call", () => {
		const { engine, signals } = makeEngine([labelRule("a", "click", "First"), labelRule("b", "click", "Second")]);
		engine.onToolStart(start("call-1", "click"));
		expect(signals).toEqual([{ active: true, label: "First" }]);
	});

	test("runs every rule on start even after a match, for stateful side effects", () => {
		const seen: string[] = [];
		const spyRule: BlockRule = {
			id: "spy",
			onToolStart: event => {
				seen.push(event.toolCallId);
				return undefined;
			},
		};
		const { engine } = makeEngine([labelRule("a", "click", "Clicking"), spyRule]);
		engine.onToolStart(start("call-1", "click"));
		expect(seen).toEqual(["call-1"]);
	});

	test("clear() closes every outstanding block once", () => {
		const { engine, signals } = makeEngine([labelRule("a", "click", "Clicking"), labelRule("b", "type", "Typing")]);
		engine.onToolStart(start("call-1", "click"));
		engine.onToolStart(start("call-2", "type"));
		signals.length = 0;
		engine.clear();
		expect(signals).toEqual([
			{ active: false, label: undefined },
			{ active: false, label: undefined },
		]);
		expect(engine.openCount).toBe(0);
	});
});

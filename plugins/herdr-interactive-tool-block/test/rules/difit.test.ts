import { describe, expect, test } from "bun:test";

import { difitRule } from "../../src/rules/difit.ts";

function start(toolName: string, args: unknown) {
	return { toolCallId: "call-1", toolName, args };
}

describe("difitRule", () => {
	test("blocks only on a difit hub wait", () => {
		const rule = difitRule();
		expect(rule.onToolStart(start("hub", { op: "wait", name: "difit" }))).toBe("difit review");
	});

	test("ignores other hub ops, other wait targets, and non-hub tools", () => {
		const rule = difitRule();
		expect(rule.onToolStart(start("hub", { op: "start", name: "difit" }))).toBeUndefined();
		expect(rule.onToolStart(start("hub", { op: "wait", name: "plannotator" }))).toBeUndefined();
		expect(rule.onToolStart(start("bash", { command: "difit" }))).toBeUndefined();
		expect(rule.onToolStart(start("hub", null))).toBeUndefined();
	});
});

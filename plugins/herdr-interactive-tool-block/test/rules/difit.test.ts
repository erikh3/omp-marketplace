import { describe, expect, test } from "bun:test";

import { difitRule } from "../../src/rules/difit.ts";

function start(toolName: string, args: unknown) {
	return { toolCallId: "call-1", toolName, args };
}

describe("difitRule bash commands", () => {
	test("blocks on a difit launch command", () => {
		const rule = difitRule();
		expect(rule.onToolStart(start("bash", { command: "difit HEAD~1" }))).toBe("difit review");
		expect(rule.onToolStart(start("bash", { command: "difit working --comment '{}'" }))).toBe("difit review");
	});

	test("blocks on npx difit and env-prefixed invocations", () => {
		const rule = difitRule();
		expect(rule.onToolStart(start("bash", { command: "npx difit feature main" }))).toBe("difit review");
		expect(rule.onToolStart(start("bash", { command: "env FOO=bar difit ." }))).toBe("difit review");
	});

	test("does not match a command that merely mentions difit later", () => {
		const rule = difitRule();
		expect(rule.onToolStart(start("bash", { command: "echo difit" }))).toBeUndefined();
		expect(rule.onToolStart(start("bash", { command: "git log" }))).toBeUndefined();
	});
});

describe("difitRule legacy hub wait", () => {
	test("blocks on a difit hub wait and ignores other hub ops or targets", () => {
		const rule = difitRule();
		expect(rule.onToolStart(start("hub", { op: "wait", name: "difit" }))).toBe("difit review");
		expect(rule.onToolStart(start("hub", { op: "start", name: "difit" }))).toBeUndefined();
		expect(rule.onToolStart(start("hub", { op: "wait", name: "plannotator" }))).toBeUndefined();
		expect(rule.onToolStart(start("hub", null))).toBeUndefined();
	});
});

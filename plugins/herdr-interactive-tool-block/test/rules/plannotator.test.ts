import { describe, expect, test } from "bun:test";

import { plannotatorRule } from "../../src/rules/plannotator.ts";

function start(toolName: string, args: unknown) {
	return { toolCallId: "call-1", toolName, args };
}

describe("plannotatorRule bash commands", () => {
	test("blocks on a plannotator review command", () => {
		const rule = plannotatorRule();
		expect(rule.onToolStart(start("bash", { command: "plannotator review ./worktree" }))).toBe("plannotator review");
	});

	test("blocks on a gated annotate command and env-prefixed invocations", () => {
		const rule = plannotatorRule();
		expect(rule.onToolStart(start("bash", { command: "plannotator annotate plan.md --gate" }))).toBe("plannotator review");
		expect(rule.onToolStart(start("bash", { command: "env FOO=bar plannotator review ." }))).toBe("plannotator review");
	});

	test("ignores a non-gated annotate and unrelated commands", () => {
		const rule = plannotatorRule();
		expect(rule.onToolStart(start("bash", { command: "plannotator annotate plan.md" }))).toBeUndefined();
		expect(rule.onToolStart(start("bash", { command: "git status" }))).toBeUndefined();
	});
});

describe("plannotatorRule hub sessions", () => {
	test("blocks on a wait for a session started as a plannotator application", () => {
		const rule = plannotatorRule();
		expect(rule.onToolStart(start("hub", { op: "start", application: "plannotator", name: "review-7" }))).toBeUndefined();
		expect(rule.onToolStart(start("hub", { op: "wait", name: "review-7" }))).toBe("plannotator review");
	});

	test("blocks on a wait for any plannotator-prefixed name without a prior start", () => {
		const rule = plannotatorRule();
		expect(rule.onToolStart(start("hub", { op: "wait", name: "plannotator-123" }))).toBe("plannotator review");
	});

	test("ignores a wait for an unknown, non-prefixed session", () => {
		const rule = plannotatorRule();
		expect(rule.onToolStart(start("hub", { op: "wait", name: "difit" }))).toBeUndefined();
	});

	test("sessions are per-rule-instance, not shared", () => {
		const first = plannotatorRule();
		first.onToolStart(start("hub", { op: "start", application: "plannotator", name: "review-7" }));
		const second = plannotatorRule();
		expect(second.onToolStart(start("hub", { op: "wait", name: "review-7" }))).toBeUndefined();
	});
});

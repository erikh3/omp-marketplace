import { describe, expect, test } from "bun:test";

import { Checkpoints, canonicalPlanTarget, canonicalToolTarget } from "../src/checkpoints.ts";

describe("notification checkpoints", () => {
	test("canonical tool targets ignore property order but distinguish changed inputs", () => {
		const first = canonicalToolTarget("ask", { questions: [{ id: "release", options: ["yes", "no"] }] });
		const reordered = canonicalToolTarget("ask", { questions: [{ options: ["yes", "no"], id: "release" }] });
		const changed = canonicalToolTarget("ask", { questions: [{ id: "release", options: ["yes", "later"] }] });
		expect(reordered).toBe(first);
		expect(changed).not.toBe(first);
	});

	test("keeps a settled outcome until new background evidence", () => {
		const checkpoints = new Checkpoints();
		checkpoints.enable();
		checkpoints.startTask();
		const first = checkpoints.outcome();
		expect(first).toBeDefined();
		if (!first) throw new Error("expected outcome checkpoint");
		expect(checkpoints.resolve(first, "silent")).toBe("accepted");
		expect(checkpoints.outcome()).toBe(first);
		expect(checkpoints.outcome(true)?.id).not.toBe(first.id);
	});

	test("releases consumed unresolved targets while retaining their aggregate count", () => {
		const checkpoints = new Checkpoints();
		checkpoints.enable();
		checkpoints.startTask();
		for (let index = 0; index < 20; index++) {
			const target = canonicalToolTarget("ask", { id: index });
			const checkpoint = checkpoints.attention(target);
			expect(checkpoint).toBeDefined();
			if (!checkpoint) throw new Error("expected attention checkpoint");
			expect(checkpoints.markUnresolved(checkpoint, "no safe recovery")).toBe(true);
			checkpoints.consumeTarget(target);
			expect(checkpoints.find(checkpoint.id, "attention")).toBeUndefined();
			expect(checkpoints.isResolved(checkpoint.id, "attention")).toBe(false);
			expect(checkpoints.resolve(checkpoint, "silent")).toBe("stale");
		}
		expect(checkpoints.unresolvedCount()).toBe(20);
		expect(checkpoints.attention(canonicalPlanTarget("/plan.md", "content"))).toBeDefined();
		expect(checkpoints.outcome()).toBeDefined();
	});

	test("invalidates old decisions on disable and task change", () => {
		const checkpoints = new Checkpoints();
		checkpoints.enable();
		const checkpoint = checkpoints.outcome();
		if (!checkpoint) throw new Error("expected outcome checkpoint");
		checkpoints.disable();
		expect(checkpoints.find(checkpoint.id, "outcome")).toBeUndefined();
		checkpoints.enable();
		const next = checkpoints.outcome();
		if (!next) throw new Error("expected outcome checkpoint");
		checkpoints.startTask();
		expect(checkpoints.find(next.id, "outcome")).toBeUndefined();
	});

	test("retires superseded unresolved outcomes while retaining their aggregate count", () => {
		const checkpoints = new Checkpoints();
		checkpoints.enable();
		let outcome = checkpoints.outcome();
		if (!outcome) throw new Error("expected outcome checkpoint");
		for (let index = 0; index < 20; index++) {
			expect(checkpoints.markUnresolved(outcome, "decision omitted")).toBe(true);
			const next = checkpoints.outcome(true);
			expect(next).toBeDefined();
			if (!next) throw new Error("expected replacement outcome checkpoint");
			expect(checkpoints.find(outcome.id, "outcome")).toBeUndefined();
			expect(checkpoints.isResolved(outcome.id, "outcome")).toBe(false);
			outcome = next;
		}
		expect(checkpoints.unresolvedCount()).toBe(20);
	});

	test("bounds unconsumed pending attention while reusing its target", () => {
		const checkpoints = new Checkpoints();
		checkpoints.enable();
		const target = canonicalToolTarget("ask", { id: 0 });
		const first = checkpoints.attention(target);
		expect(first).toBeDefined();
		expect(checkpoints.attention(target)).toBe(first);
		for (let index = 1; index < 16; index++) expect(checkpoints.attention(canonicalToolTarget("ask", { id: index }))).toBeDefined();
		expect(checkpoints.attention(canonicalToolTarget("ask", { id: 16 }))).toBeUndefined();
	});
});

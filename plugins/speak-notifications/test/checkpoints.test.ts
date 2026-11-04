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

	test("releases consumed resolved targets while retaining unresolved count", () => {
		const checkpoints = new Checkpoints();
		checkpoints.enable();
		checkpoints.startTask();
		for (let index = 0; index < 20; index++) {
			const target = canonicalToolTarget("ask", { id: index });
			const checkpoint = checkpoints.attention(target);
			expect(checkpoint).toBeDefined();
			if (!checkpoint) throw new Error("expected attention checkpoint");
			checkpoints.resolve(checkpoint, "silent");
			checkpoints.consumeTarget(target);
		}
		const unresolved = checkpoints.attention(canonicalPlanTarget("/plan.md", "content"));
		if (!unresolved) throw new Error("expected attention checkpoint");
		expect(checkpoints.markUnresolved(unresolved, "no safe recovery")).toBe(true);
		expect(checkpoints.unresolvedCount()).toBe(1);
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

	test("does not retain unresolved decisions as accepted identifier tombstones", () => {
		const checkpoints = new Checkpoints();
		checkpoints.enable();
		const checkpoint = checkpoints.attention(canonicalToolTarget("ask", { id: "remove" }));
		if (!checkpoint) throw new Error("expected attention checkpoint");
		expect(checkpoints.markUnresolved(checkpoint, "no safe recovery")).toBe(true);
		checkpoints.consumeTarget(checkpoint.target!);
		expect(checkpoints.isResolved(checkpoint.id, "attention")).toBe(false);
		expect(checkpoints.find(checkpoint.id, "attention")?.decision).toBe("unresolved");
	});

	test("rejects attention admission after the active checkpoint bound", () => {
		const checkpoints = new Checkpoints();
		checkpoints.enable();
		for (let index = 0; index < 16; index++) expect(checkpoints.attention(canonicalToolTarget("ask", { id: index }))).toBeDefined();
		expect(checkpoints.attention(canonicalToolTarget("ask", { id: 16 }))).toBeUndefined();
	});
});

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

import herdrInteractiveToolBlock from "../src/index.ts";

type Handler = (event: unknown, ctx: ExtensionContext) => Promise<unknown> | unknown;

interface BusEvent {
	active: boolean;
	label?: string;
}

const originalHerdrEnv = process.env.HERDR_ENV;

function asBusEvent(data: unknown): BusEvent {
	if (!data || typeof data !== "object" || !("active" in data)) throw new Error("unexpected herdr:blocked payload");
	const active = (data as { active: unknown }).active;
	const label = "label" in data ? (data as { label: unknown }).label : undefined;
	if (typeof active !== "boolean") throw new Error("herdr:blocked active must be boolean");
	return { active, label: typeof label === "string" ? label : undefined };
}

function makeContext(kind: "main" | "sub" = "main"): ExtensionContext {
	return {
		agent: { kind, id: "agent-1", name: kind, depth: kind === "main" ? 0 : 1 },
		cwd: "/tmp/herdr-interactive-tool-block-test",
	} as unknown as ExtensionContext;
}

function makeHarness() {
	const handlers = new Map<string, Handler>();
	const events: BusEvent[] = [];
	const pi = {
		logger: { warn: () => undefined },
		on: (event: string, handler: Handler) => handlers.set(event, handler),
		events: {
			emit: (channel: string, data: unknown) => {
				if (channel === "herdr:blocked") events.push(asBusEvent(data));
			},
			on: () => () => undefined,
		},
	} as unknown as ExtensionAPI;
	herdrInteractiveToolBlock(pi);
	return { handlers, events };
}

function fire(handlers: Map<string, Handler>, event: string, payload: unknown, ctx: ExtensionContext) {
	const handler = handlers.get(event);
	if (!handler) throw new Error(`${event} handler not registered`);
	return handler(payload, ctx);
}

/** Fire session_start and await it, so rule discovery + engine build complete. */
async function boot(handlers: Map<string, Handler>, ctx: ExtensionContext) {
	await fire(handlers, "session_start", { type: "session_start" }, ctx);
}

function call(toolCallId: string, toolName: string, intent?: string) {
	return { type: "tool_call", toolCallId, toolName, input: intent === undefined ? {} : { intent } };
}

function result(toolCallId: string, toolName: string, isError = false) {
	return { type: "tool_result", toolCallId, toolName, input: {}, content: [], isError };
}

function bashCall(toolCallId: string, command: string) {
	return { type: "tool_call", toolCallId, toolName: "bash", input: { command } };
}

beforeEach(() => {
	process.env.HERDR_ENV = "1";
});

afterEach(() => {
	if (originalHerdrEnv === undefined) delete process.env.HERDR_ENV;
	else process.env.HERDR_ENV = originalHerdrEnv;
});

describe("wiring", () => {
	test("brackets a default browser-tools call for the main session", async () => {
		const { handlers, events } = makeHarness();
		const ctx = makeContext("main");
		await boot(handlers, ctx);
		fire(handlers, "tool_call", call("call-1", "mcp__browser_tools_click", "Clicking link"), ctx);
		fire(handlers, "tool_result", result("call-1", "mcp__browser_tools_click"), ctx);
		expect(events).toEqual([
			{ active: true, label: "Clicking link" },
			{ active: false, label: undefined },
		]);
	});

	test("blocks on a difit launch and a plannotator review, which ship enabled by default", async () => {
		const { handlers, events } = makeHarness();
		const ctx = makeContext("main");
		await boot(handlers, ctx);
		fire(handlers, "tool_call", bashCall("d1", "difit HEAD~1"), ctx);
		fire(handlers, "tool_call", bashCall("p1", "plannotator review ."), ctx);
		expect(events).toEqual([
			{ active: true, label: "difit review" },
			{ active: true, label: "plannotator review" },
		]);
	});

	test("does not report for a subagent session", async () => {
		const { handlers, events } = makeHarness();
		const ctx = makeContext("sub");
		await boot(handlers, ctx);
		fire(handlers, "tool_call", call("call-1", "mcp__browser_tools_click"), ctx);
		fire(handlers, "tool_result", result("call-1", "mcp__browser_tools_click"), ctx);
		expect(events).toEqual([]);
	});

	test("clears an outstanding block on session shutdown", async () => {
		const { handlers, events } = makeHarness();
		const ctx = makeContext("main");
		await boot(handlers, ctx);
		fire(handlers, "tool_call", call("call-1", "mcp__browser_tools_click"), ctx);
		fire(handlers, "session_shutdown", { type: "session_shutdown" }, ctx);
		expect(events).toHaveLength(2);
		expect(events[1]?.active).toBe(false);
	});

	test("clears the block when a matched tool call ends in error", async () => {
		const { handlers, events } = makeHarness();
		const ctx = makeContext("main");
		await boot(handlers, ctx);
		fire(handlers, "tool_call", call("call-1", "mcp__browser_tools_click", "Clicking"), ctx);
		fire(handlers, "tool_result", result("call-1", "mcp__browser_tools_click", true), ctx);
		expect(events).toEqual([
			{ active: true, label: "Clicking" },
			{ active: false, label: undefined },
		]);
	});

	test("registers no handlers when HERDR_ENV is unset", () => {
		delete process.env.HERDR_ENV;
		const { handlers } = makeHarness();
		expect(handlers.size).toBe(0);
	});
});

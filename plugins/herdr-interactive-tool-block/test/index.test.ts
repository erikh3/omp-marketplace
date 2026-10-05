import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

import herdrInteractiveToolBlock from "../src/index.ts";

type Handler = (event: unknown, ctx: ExtensionContext) => Promise<unknown> | unknown;

interface BusEvent {
	active: boolean;
	label?: string;
}

const originalHerdrEnv = process.env.HERDR_ENV;

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
				if (channel === "herdr:blocked") events.push(data as BusEvent);
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

function start(toolCallId: string, toolName: string, intent?: string) {
	return { type: "tool_execution_start", toolCallId, toolName, args: {}, intent };
}

function end(toolCallId: string, toolName: string) {
	return { type: "tool_execution_end", toolCallId, toolName, result: {}, isError: false };
}

beforeEach(() => {
	process.env.HERDR_ENV = "1";
});

afterEach(() => {
	if (originalHerdrEnv === undefined) delete process.env.HERDR_ENV;
	else process.env.HERDR_ENV = originalHerdrEnv;
});

describe("wiring", () => {
	test("brackets a default interactive tool for the main session", () => {
		const { handlers, events } = makeHarness();
		const ctx = makeContext("main");
		fire(handlers, "tool_execution_start", start("call-1", "mcp__browser_tools_click", "Clicking link"), ctx);
		fire(handlers, "tool_execution_end", end("call-1", "mcp__browser_tools_click"), ctx);
		expect(events).toEqual([
			{ active: true, label: "Clicking link" },
			{ active: false, label: undefined },
		]);
	});

	test("blocks on a difit wait and a plannotator review, which ship enabled by default", () => {
		const { handlers, events } = makeHarness();
		const ctx = makeContext("main");
		fire(handlers, "tool_execution_start", { type: "tool_execution_start", toolCallId: "d1", toolName: "bash", args: { command: "difit HEAD~1" } }, ctx);
		fire(handlers, "tool_execution_start", { type: "tool_execution_start", toolCallId: "p1", toolName: "bash", args: { command: "plannotator review ." } }, ctx);
		expect(events).toEqual([
			{ active: true, label: "difit review" },
			{ active: true, label: "plannotator review" },
		]);
	});

	test("does not report for a subagent session", () => {
		const { handlers, events } = makeHarness();
		const ctx = makeContext("sub");
		fire(handlers, "tool_execution_start", start("call-1", "mcp__browser_tools_click"), ctx);
		fire(handlers, "tool_execution_end", end("call-1", "mcp__browser_tools_click"), ctx);
		expect(events).toEqual([]);
	});

	test("clears an outstanding block on session shutdown", () => {
		const { handlers, events } = makeHarness();
		const ctx = makeContext("main");
		fire(handlers, "tool_execution_start", start("call-1", "mcp__browser_tools_click"), ctx);
		fire(handlers, "session_shutdown", { type: "session_shutdown" }, ctx);
		expect(events).toHaveLength(2);
		expect(events[1]?.active).toBe(false);
	});

	test("clears the block when a matched tool call ends in error", () => {
		const { handlers, events } = makeHarness();
		const ctx = makeContext("main");
		fire(handlers, "tool_execution_start", start("call-1", "mcp__browser_tools_click", "Clicking"), ctx);
		fire(handlers, "tool_execution_end", { type: "tool_execution_end", toolCallId: "call-1", toolName: "mcp__browser_tools_click", result: {}, isError: true }, ctx);
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

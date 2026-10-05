import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

import herdrInteractiveToolBlock, {
	blockLabel,
	DEFAULT_TOOL_PATTERNS,
	isBlockingTool,
} from "../src/index.ts";

type Handler = (event: unknown, ctx: ExtensionContext) => Promise<unknown> | unknown;

interface BusEvent {
	channel: string;
	data: { active: boolean; label?: string };
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
			emit: (channel: string, data: unknown) => events.push({ channel, data: data as BusEvent["data"] }),
			on: () => () => undefined,
		},
	} as unknown as ExtensionAPI;
	herdrInteractiveToolBlock(pi);
	return { handlers, events };
}

function fire(handlers: Map<string, Handler>, event: string, payload: unknown, ctx: ExtensionContext): Promise<unknown> | unknown {
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

describe("isBlockingTool", () => {
	test("matches the mounted browser-tools click tool regardless of server prefix", () => {
		expect(isBlockingTool("mcp__browser_tools_chrome_browser_tools_click", DEFAULT_TOOL_PATTERNS)).toBe(true);
		expect(isBlockingTool("mcp__browser_tools_click", DEFAULT_TOOL_PATTERNS)).toBe(true);
	});

	test("matches input_text and pick but not read-only browser tools", () => {
		expect(isBlockingTool("mcp__browser_tools_input_text", DEFAULT_TOOL_PATTERNS)).toBe(true);
		expect(isBlockingTool("mcp__browser_tools_pick", DEFAULT_TOOL_PATTERNS)).toBe(true);
		expect(isBlockingTool("mcp__browser_tools_navigate", DEFAULT_TOOL_PATTERNS)).toBe(false);
		expect(isBlockingTool("mcp__browser_tools_screenshot", DEFAULT_TOOL_PATTERNS)).toBe(false);
	});

	test("is case-insensitive and honors custom patterns", () => {
		expect(isBlockingTool("MCP__CUSTOM_CONFIRM", ["custom_confirm"])).toBe(true);
		expect(isBlockingTool("mcp__browser_tools_click", ["input_text"])).toBe(false);
	});
});

describe("blockLabel", () => {
	test("prefers the tool intent", () => {
		expect(blockLabel({ toolName: "mcp__browser_tools_click", intent: "Clicking Le Corbusier link" })).toBe(
			"Clicking Le Corbusier link",
		);
	});

	test("falls back to a tidied tool name when intent is missing or blank", () => {
		expect(blockLabel({ toolName: "mcp__browser_tools_click", intent: "   " })).toBe(
			"browser tools click waiting for input",
		);
		expect(blockLabel({ toolName: "mcp__browser_tools_input_text" })).toBe(
			"browser tools input text waiting for input",
		);
	});
});

describe("block bracketing", () => {
	test("emits active then inactive around a matching tool call", () => {
		const { handlers, events } = makeHarness();
		const ctx = makeContext("main");
		fire(handlers, "tool_execution_start", start("call-1", "mcp__browser_tools_click", "Clicking link"), ctx);
		fire(handlers, "tool_execution_end", end("call-1", "mcp__browser_tools_click"), ctx);
		expect(events).toEqual([
			{ channel: "herdr:blocked", data: { active: true, label: "Clicking link" } },
			{ channel: "herdr:blocked", data: { active: false, label: undefined } },
		]);
	});

	test("ignores a non-matching tool entirely", () => {
		const { handlers, events } = makeHarness();
		const ctx = makeContext("main");
		fire(handlers, "tool_execution_start", start("call-1", "mcp__browser_tools_navigate"), ctx);
		fire(handlers, "tool_execution_end", end("call-1", "mcp__browser_tools_navigate"), ctx);
		expect(events).toEqual([]);
	});

	test("clears only the matching call id, not an unrelated end", () => {
		const { handlers, events } = makeHarness();
		const ctx = makeContext("main");
		fire(handlers, "tool_execution_start", start("call-1", "mcp__browser_tools_click"), ctx);
		fire(handlers, "tool_execution_end", end("other", "mcp__browser_tools_screenshot"), ctx);
		expect(events).toHaveLength(1);
		expect(events[0]?.data.active).toBe(true);
		fire(handlers, "tool_execution_end", end("call-1", "mcp__browser_tools_click"), ctx);
		expect(events).toHaveLength(2);
		expect(events[1]?.data.active).toBe(false);
	});

	test("brackets each matching call independently when two overlap", () => {
		const { handlers, events } = makeHarness();
		const ctx = makeContext("main");
		fire(handlers, "tool_execution_start", start("call-1", "mcp__browser_tools_click"), ctx);
		fire(handlers, "tool_execution_start", start("call-2", "mcp__browser_tools_input_text"), ctx);
		fire(handlers, "tool_execution_end", end("call-1", "mcp__browser_tools_click"), ctx);
		fire(handlers, "tool_execution_end", end("call-2", "mcp__browser_tools_input_text"), ctx);
		expect(events.map(entry => entry.data.active)).toEqual([true, true, false, false]);
	});
});

describe("subagent guard", () => {
	test("does not report block state for a subagent session", () => {
		const { handlers, events } = makeHarness();
		const ctx = makeContext("sub");
		fire(handlers, "tool_execution_start", start("call-1", "mcp__browser_tools_click"), ctx);
		fire(handlers, "tool_execution_end", end("call-1", "mcp__browser_tools_click"), ctx);
		expect(events).toEqual([]);
	});
});

describe("shutdown cleanup", () => {
	test("clears an outstanding block when the session shuts down mid-approval", () => {
		const { handlers, events } = makeHarness();
		const ctx = makeContext("main");
		fire(handlers, "tool_execution_start", start("call-1", "mcp__browser_tools_click"), ctx);
		fire(handlers, "session_shutdown", { type: "session_shutdown" }, ctx);
		expect(events).toHaveLength(2);
		expect(events[1]?.data.active).toBe(false);
	});
});

describe("disabled outside Herdr", () => {
	test("registers no handlers when HERDR_ENV is unset", () => {
		delete process.env.HERDR_ENV;
		const { handlers } = makeHarness();
		expect(handlers.size).toBe(0);
	});
});

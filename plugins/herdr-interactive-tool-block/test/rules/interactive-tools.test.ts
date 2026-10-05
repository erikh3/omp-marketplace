import { describe, expect, test } from "bun:test";

import {
	DEFAULT_TOOL_PATTERNS,
	interactiveLabel,
	interactiveToolsRule,
	matchesPattern,
} from "../../src/rules/interactive-tools.ts";

function start(toolName: string, intent?: string) {
	return { toolCallId: "call-1", toolName, args: {}, intent };
}

describe("matchesPattern", () => {
	test("matches the click tool under either MCP mount name form", () => {
		expect(matchesPattern("mcp__browser_tools_chrome_browser_tools_click", DEFAULT_TOOL_PATTERNS)).toBe(true);
		expect(matchesPattern("mcp__browser_tools_click", DEFAULT_TOOL_PATTERNS)).toBe(true);
	});

	test("matches input_text and pick but not read-only browser tools", () => {
		expect(matchesPattern("mcp__browser_tools_input_text", DEFAULT_TOOL_PATTERNS)).toBe(true);
		expect(matchesPattern("mcp__browser_tools_pick", DEFAULT_TOOL_PATTERNS)).toBe(true);
		expect(matchesPattern("mcp__browser_tools_navigate", DEFAULT_TOOL_PATTERNS)).toBe(false);
		expect(matchesPattern("mcp__browser_tools_screenshot", DEFAULT_TOOL_PATTERNS)).toBe(false);
	});

	test("is case-insensitive and honors custom patterns", () => {
		expect(matchesPattern("MCP__CUSTOM_CONFIRM", ["custom_confirm"])).toBe(true);
		expect(matchesPattern("mcp__browser_tools_click", ["input_text"])).toBe(false);
	});
});

describe("interactiveLabel", () => {
	test("prefers the tool intent", () => {
		expect(interactiveLabel({ toolName: "mcp__browser_tools_click", intent: "Clicking Le Corbusier link" })).toBe(
			"Clicking Le Corbusier link",
		);
	});

	test("falls back to a tidied tool name when intent is missing or blank", () => {
		expect(interactiveLabel({ toolName: "mcp__browser_tools_click", intent: "   " })).toBe("browser tools click waiting for input");
		expect(interactiveLabel({ toolName: "mcp__browser_tools_input_text" })).toBe("browser tools input text waiting for input");
	});
});

describe("interactiveToolsRule", () => {
	test("labels a matching call and ignores a non-matching one", () => {
		const rule = interactiveToolsRule();
		expect(rule.onToolStart(start("mcp__browser_tools_click", "Clicking link"))).toBe("Clicking link");
		expect(rule.onToolStart(start("mcp__browser_tools_navigate"))).toBeUndefined();
	});

	test("honors a custom pattern list", () => {
		const rule = interactiveToolsRule(["custom_confirm"]);
		expect(rule.onToolStart(start("mcp__custom_confirm", "Confirm"))).toBe("Confirm");
		expect(rule.onToolStart(start("mcp__browser_tools_click"))).toBeUndefined();
	});
});

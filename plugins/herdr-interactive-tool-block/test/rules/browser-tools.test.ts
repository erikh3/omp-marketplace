import { describe, expect, test } from "bun:test";

import {
	BROWSER_TOOLS_INTERACTIVE,
	browserToolLabel,
	browserToolsRule,
	isInteractiveBrowserTool,
} from "../../src/rules/browser-tools.ts";

function start(toolName: string, intent?: string) {
	return { toolCallId: "call-1", toolName, args: {}, intent };
}

describe("isInteractiveBrowserTool", () => {
	test("matches click under either MCP mount name form", () => {
		expect(isInteractiveBrowserTool("mcp__browser_tools_chrome_browser_tools_click", BROWSER_TOOLS_INTERACTIVE)).toBe(true);
		expect(isInteractiveBrowserTool("mcp__browser_tools_click", BROWSER_TOOLS_INTERACTIVE)).toBe(true);
	});

	test("matches input_text and pick but not read-only browser tools", () => {
		expect(isInteractiveBrowserTool("mcp__browser_tools_input_text", BROWSER_TOOLS_INTERACTIVE)).toBe(true);
		expect(isInteractiveBrowserTool("mcp__browser_tools_pick", BROWSER_TOOLS_INTERACTIVE)).toBe(true);
		expect(isInteractiveBrowserTool("mcp__browser_tools_navigate", BROWSER_TOOLS_INTERACTIVE)).toBe(false);
		expect(isInteractiveBrowserTool("mcp__browser_tools_screenshot", BROWSER_TOOLS_INTERACTIVE)).toBe(false);
	});

	test("does not match a non-browser tool even if it ends in a known op", () => {
		expect(isInteractiveBrowserTool("mcp__other_mcp_click", BROWSER_TOOLS_INTERACTIVE)).toBe(false);
		expect(isInteractiveBrowserTool("bash", BROWSER_TOOLS_INTERACTIVE)).toBe(false);
	});

	test("honors a custom op list", () => {
		expect(isInteractiveBrowserTool("mcp__browser_tools_hover", ["hover"])).toBe(true);
		expect(isInteractiveBrowserTool("mcp__browser_tools_click", ["hover"])).toBe(false);
	});
});

describe("browserToolLabel", () => {
	test("prefers the tool intent", () => {
		expect(browserToolLabel({ toolName: "mcp__browser_tools_click", intent: "Clicking Le Corbusier link" })).toBe(
			"Clicking Le Corbusier link",
		);
	});

	test("falls back to a tidied tool name when intent is missing or blank", () => {
		expect(browserToolLabel({ toolName: "mcp__browser_tools_click", intent: "   " })).toBe("browser tools click waiting for input");
		expect(browserToolLabel({ toolName: "mcp__browser_tools_input_text" })).toBe("browser tools input text waiting for input");
	});
});

describe("browserToolsRule", () => {
	test("labels an interactive call and ignores a read-only one", () => {
		const rule = browserToolsRule();
		expect(rule.onToolStart(start("mcp__browser_tools_click", "Clicking link"))).toBe("Clicking link");
		expect(rule.onToolStart(start("mcp__browser_tools_navigate"))).toBeUndefined();
	});
});

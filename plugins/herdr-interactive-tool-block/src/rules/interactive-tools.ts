import type { BlockRule, ToolStartInfo } from "./types.ts";

export const DEFAULT_TOOL_PATTERNS: readonly string[] = [
	"browser_tools_click",
	"browser_tools_input_text",
	"browser_tools_pick",
];

/** Whether a tool name matches any configured pattern (case-insensitive substring). */
export function matchesPattern(toolName: string, patterns: readonly string[]): boolean {
	const name = toolName.toLowerCase();
	return patterns.some(pattern => name.includes(pattern.toLowerCase()));
}

/** Human-readable label from a tool start: its intent, else a tidied tool name. */
export function interactiveLabel(event: Pick<ToolStartInfo, "toolName" | "intent">): string {
	const intent = typeof event.intent === "string" ? event.intent.trim() : "";
	if (intent.length > 0) return intent;
	const stem = event.toolName.replace(/^mcp__/, "").replace(/_/g, " ").trim();
	return `${stem || event.toolName} waiting for input`;
}

/**
 * Blocks while an interactive tool waits for the user mid-execution. omp approves
 * the tool at its own gate and then runs it; a browser-tools `click`/`input_text`/
 * `pick` call blocks inside the MCP server waiting for Chrome confirmation, so omp
 * still sees the tool executing and the pane would otherwise stay `working`.
 */
export function interactiveToolsRule(patterns: readonly string[] = DEFAULT_TOOL_PATTERNS): BlockRule {
	return {
		id: "interactive-tools",
		onToolStart(event) {
			if (!matchesPattern(event.toolName, patterns)) return undefined;
			return interactiveLabel(event);
		},
	};
}

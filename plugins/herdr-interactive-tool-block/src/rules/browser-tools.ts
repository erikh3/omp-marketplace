import type { BlockConfig } from "../config.ts";
import type { RuleFactory } from "./index.ts";
import type { BlockRule, ToolStartInfo } from "./types.ts";

/** Browser-tools MCP operations that wait for the user in Chrome mid-execution. */
export const BROWSER_TOOLS_INTERACTIVE: readonly string[] = ["click", "input_text", "pick"];

/**
 * Whether a tool name is an interactive browser-tools operation. Matches the
 * `browser_tools_` MCP segment followed by one of the interactive op names, so it
 * works under both mount name forms: `mcp__browser_tools_click` and the longer
 * `mcp__browser_tools_chrome_browser_tools_click`.
 */
export function isInteractiveBrowserTool(toolName: string, ops: readonly string[]): boolean {
	const name = toolName.toLowerCase();
	if (!name.includes("browser_tools_")) return false;
	return ops.some(op => name.endsWith(`_${op.toLowerCase()}`) || name.includes(`browser_tools_${op.toLowerCase()}`));
}

/** Human-readable label from a tool start: its intent, else a tidied tool name. */
export function browserToolLabel(event: Pick<ToolStartInfo, "toolName" | "intent">): string {
	const intent = typeof event.intent === "string" ? event.intent.trim() : "";
	if (intent.length > 0) return intent;
	const stem = event.toolName.replace(/^mcp__/, "").replace(/_/g, " ").trim();
	return `${stem || event.toolName} waiting for input`;
}

/**
 * Blocks while a browser-tools MCP call waits for the user mid-execution. omp
 * approves the tool at its own gate and runs it; a `click`, `input_text`, or `pick`
 * then blocks inside the MCP server waiting for Chrome confirmation, so omp still
 * sees the tool executing and the pane would otherwise stay `working`.
 *
 * @param ops Interactive op names to match. Defaults to click/input_text/pick.
 */
export function browserToolsRule(ops: readonly string[] = BROWSER_TOOLS_INTERACTIVE): BlockRule {
	return {
		id: "browser-tools",
		onToolStart(event) {
			if (!isInteractiveBrowserTool(event.toolName, ops)) return undefined;
			return browserToolLabel(event);
		},
	};
}

/** Rule module entry: builds the browser-tools rule from config. */
const factory: RuleFactory = (config: BlockConfig) => browserToolsRule(config.browserToolsOps ?? BROWSER_TOOLS_INTERACTIVE);
export default factory;

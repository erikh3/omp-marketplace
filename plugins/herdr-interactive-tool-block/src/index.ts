import type {
	ExtensionAPI,
	ExtensionContext,
	ToolExecutionEndEvent,
	ToolExecutionStartEvent,
} from "@oh-my-pi/pi-coding-agent";
import { getPluginSettings } from "@oh-my-pi/pi-coding-agent/extensibility/plugins";

/**
 * Shared `pi.events` channel the Herdr-managed omp integration subscribes to.
 * Payload `{ active, label }` ref-counts an external block, flipping the pane to
 * `blocked` while `active` reports stay outstanding. See
 * `~/.omp/agent/extensions/herdr-omp-agent-state.ts`.
 */
const HERDR_BLOCKED_CHANNEL = "herdr:blocked";

const PLUGIN_NAME = "herdr-interactive-tool-block";

export const DEFAULT_TOOL_PATTERNS: readonly string[] = [
	"browser_tools_click",
	"browser_tools_input_text",
	"browser_tools_pick",
];

export interface BlockConfig {
	enabled: boolean;
	tools: readonly string[];
}

export const DEFAULT_CONFIG: BlockConfig = {
	enabled: true,
	tools: DEFAULT_TOOL_PATTERNS,
};

function toolPatterns(value: unknown): readonly string[] {
	if (!Array.isArray(value)) return DEFAULT_TOOL_PATTERNS;
	const valid = value.filter(
		(entry): entry is string => typeof entry === "string" && entry.trim().length > 0,
	);
	return valid.length > 0 ? [...new Set(valid.map(entry => entry.trim()))] : DEFAULT_TOOL_PATTERNS;
}

export async function loadConfig(cwd: string): Promise<BlockConfig> {
	const settings = await getPluginSettings(PLUGIN_NAME, cwd);
	return {
		enabled: settings["enabled"] !== false,
		tools: toolPatterns(settings["tools"]),
	};
}

/** Whether a tool name matches any configured blocking pattern (case-insensitive substring). */
export function isBlockingTool(toolName: string, patterns: readonly string[]): boolean {
	const name = toolName.toLowerCase();
	return patterns.some(pattern => name.includes(pattern.toLowerCase()));
}

/** Human-readable block label from a tool start event: its intent, else a tidied tool name. */
export function blockLabel(event: Pick<ToolExecutionStartEvent, "toolName" | "intent">): string {
	const intent = typeof event.intent === "string" ? event.intent.trim() : "";
	if (intent.length > 0) return intent;
	const stem = event.toolName.replace(/^mcp__/, "").replace(/_/g, " ").trim();
	return `${stem || event.toolName} waiting for input`;
}

/**
 * Reports the Herdr pane as blocked while an interactive tool waits for user input
 * mid-execution.
 *
 * omp approves a tool at its own gate and then runs it; a browser-tools
 * `click`/`input_text`/`pick` call blocks inside the MCP server waiting for the user
 * to confirm in Chrome. omp still sees the tool executing, so the Herdr-managed omp
 * integration keeps the pane `working`. This plugin brackets each matching tool call
 * with `herdr:blocked` events on the shared `pi.events` bus, which that integration
 * ref-counts into a `blocked` pane state and clears when the call ends.
 */
export default function herdrInteractiveToolBlock(pi: ExtensionAPI): void {
	if (process.env.HERDR_ENV !== "1") return;

	let config: BlockConfig = DEFAULT_CONFIG;
	let isMainSession = false;
	// toolCallIds we have reported as blocked and must later clear.
	const outstanding = new Set<string>();

	void loadConfig(process.cwd())
		.then(loaded => {
			config = loaded;
		})
		.catch(error => {
			pi.logger.warn(`${PLUGIN_NAME}: failed to load settings`, {
				error: error instanceof Error ? error.message : String(error),
			});
		});

	function setBlocked(active: boolean, label?: string): void {
		pi.events.emit(HERDR_BLOCKED_CHANNEL, { active, label });
	}

	function activate(ctx: ExtensionContext): boolean {
		if (!isMainSession && ctx.agent.kind === "main") isMainSession = true;
		return isMainSession;
	}

	pi.on("session_start", async (_event, ctx) => {
		activate(ctx);
		config = await loadConfig(ctx.cwd).catch(() => config);
	});

	pi.on("tool_execution_start", (event: ToolExecutionStartEvent, ctx) => {
		if (!config.enabled) return;
		if (!activate(ctx)) return;
		if (!isBlockingTool(event.toolName, config.tools)) return;
		if (outstanding.has(event.toolCallId)) return;
		outstanding.add(event.toolCallId);
		setBlocked(true, blockLabel(event));
	});

	pi.on("tool_execution_end", (event: ToolExecutionEndEvent, _ctx) => {
		if (!outstanding.delete(event.toolCallId)) return;
		setBlocked(false);
	});

	pi.on("session_shutdown", () => {
		// Clear any still-open block so a crash mid-approval does not strand the pane.
		for (const _ of outstanding) setBlocked(false);
		outstanding.clear();
	});
}

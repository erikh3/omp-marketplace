import type { ExtensionAPI, ExtensionContext, ToolExecutionEndEvent, ToolExecutionStartEvent } from "@oh-my-pi/pi-coding-agent";

import { DEFAULT_CONFIG, loadConfig, PLUGIN_NAME, type BlockConfig } from "./config.ts";
import { BlockEngine } from "./engine.ts";
import { buildRules } from "./rules/index.ts";

/**
 * Shared `pi.events` channel the Herdr-managed omp integration subscribes to.
 * Payload `{ active, label }` ref-counts an external block, flipping the pane to
 * `blocked` while any `active` report stays outstanding. See
 * `~/.omp/agent/extensions/herdr-omp-agent-state.ts`.
 */
const HERDR_BLOCKED_CHANNEL = "herdr:blocked";

/**
 * Reports the Herdr pane as blocked while a configured rule says the agent is
 * waiting on the user mid-execution. Rules are modular (see `src/rules`): the
 * built-ins cover interactive MCP tools (browser-tools click/input_text/pick),
 * difit review waits, and Plannotator review waits. Each rule classifies starting
 * tool calls; a shared engine owns the block lifecycle and emits `herdr:blocked`
 * on the bus, which the Herdr-managed omp integration ref-counts into pane state.
 */
export default function herdrInteractiveToolBlock(pi: ExtensionAPI): void {
	if (process.env.HERDR_ENV !== "1") return;
	let config: BlockConfig = DEFAULT_CONFIG;
	let isMainSession = false;
	let engine: BlockEngine | undefined;

	const emit = (active: boolean, label?: string): void => pi.events.emit(HERDR_BLOCKED_CHANNEL, { active, label });

	const rebuildEngine = (): void => {
		engine?.clear();
		engine = config.enabled ? new BlockEngine(buildRules(config), emit) : undefined;
	};
	rebuildEngine();

	const activate = (ctx: ExtensionContext): boolean => {
		if (!isMainSession && ctx.agent.kind === "main") isMainSession = true;
		return isMainSession;
	};

	pi.on("session_start", async (_event, ctx) => {
		activate(ctx);
		config = await loadConfig(ctx.cwd).catch(error => {
			pi.logger.warn(`${PLUGIN_NAME}: failed to load settings`, { error: error instanceof Error ? error.message : String(error) });
			return config;
		});
		rebuildEngine();
	});

	pi.on("tool_execution_start", (event: ToolExecutionStartEvent, ctx) => {
		if (!activate(ctx)) return;
		engine?.onToolStart(event);
	});

	pi.on("tool_execution_end", (event: ToolExecutionEndEvent) => {
		engine?.onToolEnd(event.toolCallId);
	});

	pi.on("session_shutdown", () => {
		// Clear any still-open block so a crash mid-wait does not strand the pane.
		engine?.clear();
	});
}

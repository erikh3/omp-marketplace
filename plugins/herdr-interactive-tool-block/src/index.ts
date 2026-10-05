import type { ExtensionAPI, ExtensionContext, ToolCallEvent, ToolResultEvent } from "@oh-my-pi/pi-coding-agent";

import { DEFAULT_CONFIG, loadConfig, PLUGIN_NAME, type BlockConfig } from "./config.ts";
import { BlockEngine } from "./engine.ts";
import { discoverRuleFactories, instantiateRules, type RuleFactory } from "./rules/index.ts";

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
 * built-ins cover interactive browser-tools MCP calls, difit review waits, and
 * Plannotator review waits. Each rule classifies starting tool calls; a shared
 * engine owns the block lifecycle and emits `herdr:blocked` on the bus, which the
 * Herdr-managed omp integration ref-counts into pane state.
 *
 * Lifecycle hooks are `tool_call` (pre-execution) and `tool_result` (post), NOT
 * `tool_execution_start`/`end`: only the former pair fires for MCP tool calls like
 * browser-tools, which are the main case this plugin exists for. The execution
 * events fire for native tools only, so they could never see a browser-tools wait.
 */
export default function herdrInteractiveToolBlock(pi: ExtensionAPI): void {
	if (process.env.HERDR_ENV !== "1") return;
	let config: BlockConfig = DEFAULT_CONFIG;
	let isMainSession = false;
	let engine: BlockEngine | undefined;

	const emit = (active: boolean, label?: string): void => pi.events.emit(HERDR_BLOCKED_CHANNEL, { active, label });
	const warn = (message: string): void => pi.logger.warn(`${PLUGIN_NAME}: ${message}`);

	// Rule modules are discovered on disk once; only config (enablement) changes
	// per session, so cache the factories and re-instantiate from them.
	const factoriesReady = discoverRuleFactories(undefined, warn).catch(error => {
		warn(`rule discovery failed: ${error instanceof Error ? error.message : String(error)}`);
		return [] as RuleFactory[];
	});

	const rebuildEngine = async (): Promise<void> => {
		const factories = await factoriesReady;
		engine?.clear();
		engine = config.enabled ? new BlockEngine(instantiateRules(factories, config, warn), emit) : undefined;
	};
	void rebuildEngine();

	const activate = (ctx: ExtensionContext): boolean => {
		if (!isMainSession && ctx.agent.kind === "main") isMainSession = true;
		return isMainSession;
	};

	pi.on("session_start", async (_event, ctx) => {
		activate(ctx);
		config = await loadConfig(ctx.cwd).catch(error => {
			warn(`failed to load settings: ${error instanceof Error ? error.message : String(error)}`);
			return config;
		});
		await rebuildEngine();
	});

	pi.on("tool_call", (event: ToolCallEvent, ctx) => {
		if (!activate(ctx)) return;
		const intent = "intent" in event.input && typeof event.input.intent === "string" ? event.input.intent : undefined;
		engine?.onToolStart({ toolCallId: event.toolCallId, toolName: event.toolName, args: event.input, intent });
	});

	pi.on("tool_result", (event: ToolResultEvent) => {
		engine?.onToolEnd(event.toolCallId);
	});

	pi.on("session_shutdown", () => {
		// Clear any still-open block so a crash mid-wait does not strand the pane.
		engine?.clear();
	});
}

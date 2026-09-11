import type {
	AgentEndEvent,
	ExtensionAPI,
	ExtensionContext,
	ExtensionModelQuery,
	TurnEndEvent,
} from "@oh-my-pi/pi-coding-agent";
import type { AssistantMessage, Model } from "@oh-my-pi/pi-ai";

import { DEFAULT_CONFIG, loadConfig, type CompanionConfig } from "./config.ts";
import { displayedEstimate, emptyLedger, ledgerPath, loadLedger, rollLedger, updateLedger, type Ledger, type LedgerPeriod } from "./ledger.ts";
import { estimateCostEur, isDailyCapError, isHaiModel, parseCostRates, type UsageSnapshot } from "./usage.ts";
import { CompanionWidget, type WidgetState } from "./widget.ts";

const WIDGET_KEY = "hai-proxy-companion";
const CAP_HIT_MESSAGE = "HAI daily cap hit. The wallet has requested a lie-down.";

function addUsage(period: LedgerPeriod, usage: UsageSnapshot, estimateEur: number): void {
	period.estimateEur += estimateEur;
	period.inputTokens += usage.inputTokens;
	period.outputTokens += usage.outputTokens;
	period.cacheReadTokens += usage.cacheReadTokens;
	period.cacheWriteTokens += usage.cacheWriteTokens;
}

function modelForMessage(models: ExtensionModelQuery, message: AssistantMessage): Model | undefined {
	return models.resolve(message.model) ?? models.current();
}

function stateFor(ledger: Ledger, config: CompanionConfig, sessionEstimateEur: number, context: ExtensionContext, contextGrowthTokens: number | undefined): WidgetState {
	const contextUsage = context.getContextUsage();
	return {
		sessionEstimateEur,
		dailyEstimateEur: displayedEstimate(ledger.daily.estimateEur, ledger.baseline?.dailyEur),
		monthlyEstimateEur: displayedEstimate(ledger.monthly.estimateEur, ledger.baseline?.monthlyEur),
		dailyBudgetEur: config.dailyBudgetEur,
		monthlyBudgetEur: config.monthlyBudgetEur,
		contextTokens: contextUsage?.tokens,
		contextGrowthTokens,
		capHitAt: ledger.capHitAt,
	};
}

/** Shows HAI Proxy estimates and ends the harness cleanly after a daily-cap error. */
export default function haiProxyCompanion(pi: ExtensionAPI): void {
	let config: CompanionConfig = DEFAULT_CONFIG;
	let ledger = emptyLedger();
	let sessionEstimateEur = 0;
	let previousContextTokens: number | undefined;
	let contextGrowthTokens: number | undefined;
	let widget: CompanionWidget | undefined;
	let warnedThresholds = new Set<number>();
	let capExitRequested = false;

	function refreshWidget(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		if (!config.enabled || !isHaiModel(ctx.models.current(), config)) {
			ctx.ui.setWidget(WIDGET_KEY, undefined);
			return;
		}
		const state = stateFor(ledger, config, sessionEstimateEur, ctx, contextGrowthTokens);
		ctx.ui.setWidget(
			WIDGET_KEY,
			(_tui, theme) => {
				if (widget === undefined) widget = new CompanionWidget(theme, state);
				else widget.setState(state);
				return widget;
			},
			{ placement: "belowEditor" },
		);
	}

	function warnThresholds(ctx: ExtensionContext): void {
		const percent = displayedEstimate(ledger.daily.estimateEur, ledger.baseline?.dailyEur) / config.dailyBudgetEur * 100;
		for (const threshold of config.warningPercentages) {
			if (percent < threshold || warnedThresholds.has(threshold)) continue;
			warnedThresholds.add(threshold);
			ctx.ui.notify(`HAI estimate passed ${threshold}% of the daily budget.`, "warning");
		}
	}

	function stopForDailyCap(ctx: ExtensionContext): void {
		if (!config.enabled || capExitRequested) return;
		capExitRequested = true;
		ledger = updateLedger(ledgerPath(), (current) => ({ ...current, capHitAt: new Date().toISOString() }));
		ctx.ui.notify(CAP_HIT_MESSAGE, "error");
		refreshWidget(ctx);
		ctx.abort();
		ctx.shutdown();
	}

	function recordTurn(message: AssistantMessage, ctx: ExtensionContext): void {
		const model = modelForMessage(ctx.models, message);
		if (!config.enabled || !isHaiModel(model, config) || model === undefined) return;
		if (isDailyCapError(message.errorMessage)) {
			stopForDailyCap(ctx);
			return;
		}
		const rates = parseCostRates(model.cost);
		if (rates === undefined) return;
		const usage: UsageSnapshot = {
			inputTokens: message.usage.input,
			outputTokens: message.usage.output,
			cacheReadTokens: message.usage.cacheRead,
			cacheWriteTokens: message.usage.cacheWrite,
		};
		const estimateEur = estimateCostEur(usage, rates);
		ledger = updateLedger(ledgerPath(), (current) => {
			const next = rollLedger(current);
			addUsage(next.daily, usage, estimateEur);
			addUsage(next.monthly, usage, estimateEur);
			return next;
		});
		sessionEstimateEur += estimateEur;
		const currentContextTokens = ctx.getContextUsage()?.tokens;
		contextGrowthTokens = currentContextTokens === undefined || previousContextTokens === undefined ? undefined : currentContextTokens - previousContextTokens;
		previousContextTokens = currentContextTokens;
		if (contextGrowthTokens !== undefined && contextGrowthTokens >= config.contextGrowthWarningTokens) {
			ctx.ui.notify(`HAI context grew by ${(contextGrowthTokens / 1_000).toFixed(0)}k tokens in one turn.`, "warning");
		}
		warnThresholds(ctx);
		refreshWidget(ctx);
	}

	pi.on("after_provider_response", (event, ctx) => {
		if (config.enabled && event.status === 402 && isHaiModel(ctx.models.current(), config)) stopForDailyCap(ctx);
	});

	pi.on("session_start", async (_event, ctx) => {
		config = await loadConfig();
		ledger = loadLedger(ledgerPath());
		sessionEstimateEur = 0;
		previousContextTokens = undefined;
		contextGrowthTokens = undefined;
		warnedThresholds = new Set();
		capExitRequested = false;
		refreshWidget(ctx);
	});

	pi.on("turn_end", (event: TurnEndEvent, ctx) => recordTurn(event.message as AssistantMessage, ctx));

	pi.on("turn_start", (_event, ctx) => refreshWidget(ctx));

	pi.on("agent_end", (_event: AgentEndEvent, ctx) => refreshWidget(ctx));

	pi.on("session_shutdown", (_event, ctx) => {
		if (ctx.hasUI) ctx.ui.setWidget(WIDGET_KEY, undefined);
	});

	pi.registerCommand("hai-status", {
		description: "Show HAI Proxy companion estimates and cap state",
		handler: async (_args, ctx) => {
			ledger = loadLedger(ledgerPath());
			const daily = displayedEstimate(ledger.daily.estimateEur, ledger.baseline?.dailyEur);
			const monthly = displayedEstimate(ledger.monthly.estimateEur, ledger.baseline?.monthlyEur);
			const baseline = ledger.baseline ? " Includes the manual HAI UI baseline." : "";
			ctx.ui.notify(`HAI ~€${daily.toFixed(2)}/${config.dailyBudgetEur} today, ~€${monthly.toFixed(2)}/${config.monthlyBudgetEur} month.${baseline}`, "info");
		},
	});

	pi.registerCommand("hai-baseline", {
		description: "Set or clear HAI TUI baseline. Usage: /hai-baseline <daily> <monthly> or /hai-baseline clear",
		handler: async (args, ctx) => {
			if (args.trim() === "clear") {
				ledger = updateLedger(ledgerPath(), (current) => ({ ...current, baseline: undefined }));
				refreshWidget(ctx);
				ctx.ui.notify("HAI TUI baseline cleared.", "info");
				return;
			}
			const [dailyText, monthlyText, extra] = args.trim().split(/\s+/);
			const dailyEur = Number(dailyText);
			const monthlyEur = Number(monthlyText);
			if (extra !== undefined || !Number.isFinite(dailyEur) || dailyEur < 0 || !Number.isFinite(monthlyEur) || monthlyEur < 0) {
				ctx.ui.notify("Usage: /hai-baseline <daily> <monthly> or /hai-baseline clear", "error");
				return;
			}
			ledger = updateLedger(ledgerPath(), (current) => ({ ...current, baseline: { dailyEur, monthlyEur, capturedAt: new Date().toISOString() } }));
			refreshWidget(ctx);
			ctx.ui.notify("HAI TUI baseline saved for this UTC day and month.", "info");
		},
	});
}

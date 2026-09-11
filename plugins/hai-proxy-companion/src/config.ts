import { getPluginSettings } from "@oh-my-pi/pi-coding-agent/extensibility/plugins";

export interface CompanionConfig {
	enabled: boolean;
	proxyHost: string;
	proxyPort: number;
	dailyBudgetEur: number;
	monthlyBudgetEur: number;
	warningPercentages: readonly number[];
	contextGrowthWarningTokens: number;
}

export const DEFAULT_CONFIG: CompanionConfig = {
	enabled: true,
	proxyHost: "localhost",
	proxyPort: 6655,
	dailyBudgetEur: 50,
	monthlyBudgetEur: 500,
	warningPercentages: [50, 80],
	contextGrowthWarningTokens: 100_000,
};

function positiveNumber(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function percentages(value: unknown): readonly number[] {
	if (!Array.isArray(value)) return DEFAULT_CONFIG.warningPercentages;
	const valid = value.filter((entry): entry is number => typeof entry === "number" && entry > 0 && entry < 100);
	return valid.length > 0 ? [...new Set(valid)].sort((left, right) => left - right) : DEFAULT_CONFIG.warningPercentages;
}

export async function loadConfig(): Promise<CompanionConfig> {
	const settings = await getPluginSettings("hai-proxy-companion", process.cwd());
	return {
		enabled: settings["enabled"] !== false,
		proxyHost: typeof settings["proxyHost"] === "string" && settings["proxyHost"].length > 0 ? settings["proxyHost"] : DEFAULT_CONFIG.proxyHost,
		proxyPort: positiveNumber(settings["proxyPort"], DEFAULT_CONFIG.proxyPort),
		dailyBudgetEur: positiveNumber(settings["dailyBudgetEur"], DEFAULT_CONFIG.dailyBudgetEur),
		monthlyBudgetEur: positiveNumber(settings["monthlyBudgetEur"], DEFAULT_CONFIG.monthlyBudgetEur),
		warningPercentages: percentages(settings["warningPercentages"]),
		contextGrowthWarningTokens: positiveNumber(settings["contextGrowthWarningTokens"], DEFAULT_CONFIG.contextGrowthWarningTokens),
	};
}

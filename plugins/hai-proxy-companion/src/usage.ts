import type { Model } from "@oh-my-pi/pi-ai";

import type { CompanionConfig } from "./config.ts";

export interface UsageSnapshot {
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
}

export interface CostRates {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

export function isHaiModel(model: Model | undefined, config: CompanionConfig): boolean {
	if (!model?.baseUrl) return false;
	try {
		const url = new URL(model.baseUrl);
		return url.hostname === config.proxyHost && Number(url.port || (url.protocol === "https:" ? 443 : 80)) === config.proxyPort;
	} catch {
		return false;
	}
}

export function estimateCostEur(usage: UsageSnapshot, rates: CostRates): number {
	return (usage.inputTokens * rates.input + usage.outputTokens * rates.output + usage.cacheReadTokens * rates.cacheRead + usage.cacheWriteTokens * rates.cacheWrite) / 1_000_000;
}


export function parseCostRates(value: unknown): CostRates | undefined {
	if (value === null || typeof value !== "object") return;
	const source = value as Record<string, unknown>;
	const read = (key: string): number | undefined => typeof source[key] === "number" ? source[key] : undefined;
	const input = read("input");
	const output = read("output");
	const cacheRead = read("cacheRead");
	const cacheWrite = read("cacheWrite");
	return input === undefined || output === undefined || cacheRead === undefined || cacheWrite === undefined ? undefined : { input, output, cacheRead, cacheWrite };
}

export function isDailyCapError(value: unknown): boolean {
	if (typeof value === "string") return value.includes("DAILY_CAP_EXCEEDED");
	if (value instanceof Error) return value.message.includes("DAILY_CAP_EXCEEDED");
	if (value !== null && typeof value === "object" && "errorMessage" in value) return isDailyCapError(value.errorMessage);
	return false;
}

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { DEFAULT_CONFIG } from "../src/config.ts";
import { currentUtcPeriod, emptyLedger, loadLedger, rollLedger, saveLedger, updateLedger } from "../src/ledger.ts";
import { estimateCostEur, isDailyCapError, isHaiModel } from "../src/usage.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("hai-proxy-companion usage", () => {
	test("prices final token usage with configured per-million rates", () => {
		expect(estimateCostEur({ inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 1_000_000, cacheWriteTokens: 1_000_000 }, { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.25 })).toBe(4.35);
	});

	test("recognizes a HAI daily cap error", () => {
		expect(isDailyCapError("402 DAILY_CAP_EXCEEDED")).toBe(true);
		expect(isDailyCapError("network timeout")).toBe(false);
	});

	test("matches the configured HAI host and port only", () => {
		const model = { baseUrl: "http://localhost:6655/anthropic" };
		expect(isHaiModel(model as never, DEFAULT_CONFIG)).toBe(true);
		expect(isHaiModel({ baseUrl: "http://localhost:6656/anthropic" } as never, DEFAULT_CONFIG)).toBe(false);
		expect(isHaiModel({ baseUrl: "http://127.0.0.1:6655/anthropic" } as never, DEFAULT_CONFIG)).toBe(false);
		expect(isHaiModel({ baseUrl: "https://example.test" } as never, DEFAULT_CONFIG)).toBe(false);
	});

	test("clears daily baseline while retaining monthly baseline within the same month", () => {
		const ledger = emptyLedger(new Date("2026-09-11T23:59:00.000Z"));
		ledger.baseline = { dailyEur: 4.5, monthlyEur: 27, capturedAt: "2026-09-11T23:59:00.000Z" };
		expect(rollLedger(ledger, new Date("2026-09-12T00:00:00.000Z"))).toMatchObject({
			baseline: { dailyEur: 0, monthlyEur: 27 },
		});
	});

	test("rolls daily and monthly periods in UTC", () => {
		const before = new Date("2026-09-30T23:59:00.000Z");
		const ledger = emptyLedger(before);
		ledger.daily.estimateEur = 4;
		ledger.monthly.estimateEur = 30;
		expect(currentUtcPeriod(new Date("2026-10-01T00:00:00.000Z"))).toEqual({ day: "2026-10-01", month: "2026-10" });
		expect(rollLedger(ledger, new Date("2026-10-01T00:00:00.000Z"))).toMatchObject({ daily: { estimateEur: 0 }, monthly: { estimateEur: 0 } });
	});

	test("merges sequential cross-session ledger mutations", () => {
		const directory = mkdtempSync(join(tmpdir(), "hai-proxy-companion-"));
		temporaryDirectories.push(directory);
		const path = join(directory, "ledger.json");
		saveLedger(path, emptyLedger());
		updateLedger(path, (ledger) => ({ ...ledger, daily: { ...ledger.daily, estimateEur: ledger.daily.estimateEur + 5 } }));
		updateLedger(path, (ledger) => ({ ...ledger, daily: { ...ledger.daily, estimateEur: ledger.daily.estimateEur + 3 } }));
		expect(loadLedger(path).daily.estimateEur).toBe(8);
	});

	test("writes and reloads an atomic local ledger", () => {
		const directory = mkdtempSync(join(tmpdir(), "hai-proxy-companion-"));
		temporaryDirectories.push(directory);
		const path = join(directory, "ledger.json");
		const ledger = emptyLedger(new Date("2026-09-11T10:00:00.000Z"));
		ledger.daily.estimateEur = 8.25;
		ledger.baseline = { dailyEur: 4, monthlyEur: 15, capturedAt: "2026-09-11T10:00:00.000Z" };
		saveLedger(path, ledger);
		expect(existsSync(path)).toBe(true);
		expect(loadLedger(path, new Date("2026-09-11T12:00:00.000Z"))).toMatchObject({ daily: { estimateEur: 8.25 }, baseline: { dailyEur: 4 } });
	});

	test("keeps the default local HAI endpoint", () => {
		expect([DEFAULT_CONFIG.proxyHost, DEFAULT_CONFIG.proxyPort]).toEqual(["localhost", 6655]);
	});
});

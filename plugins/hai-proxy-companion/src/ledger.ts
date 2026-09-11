import { mkdirSync, readFileSync, renameSync, rmdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

import { getAgentDir } from "@oh-my-pi/pi-coding-agent";

export interface LedgerPeriod {
	estimateEur: number;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
}

export interface AuthoritativeBaseline {
	dailyEur: number;
	monthlyEur: number;
	capturedAt: string;
}

export interface Ledger {
	version: 1;
	day: string;
	month: string;
	daily: LedgerPeriod;
	monthly: LedgerPeriod;
	baseline?: AuthoritativeBaseline;
	capHitAt?: string;
}

const LOCK_WAIT_MS = 20;
const LOCK_TIMEOUT_MS = 2_000;
const STALE_LOCK_MS = 30_000;
const WAIT_ARRAY = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));

function emptyPeriod(): LedgerPeriod {
	return { estimateEur: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
}

function isPeriod(value: unknown): value is LedgerPeriod {
	if (value === null || typeof value !== "object") return false;
	const source = value as Record<string, unknown>;
	return ["estimateEur", "inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens"].every((key) => typeof source[key] === "number");
}

function isBaseline(value: unknown): value is AuthoritativeBaseline {
	if (value === null || typeof value !== "object") return false;
	const source = value as Record<string, unknown>;
	return typeof source["dailyEur"] === "number" && typeof source["monthlyEur"] === "number" && typeof source["capturedAt"] === "string";
}

function lockPath(path: string): string {
	return `${path}.lock`;
}

function acquireLock(path: string): void {
	const lock = lockPath(path);
	const deadline = Date.now() + LOCK_TIMEOUT_MS;
	while (true) {
		try {
			mkdirSync(lock);
			return;
		} catch (error) {
			if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
			try {
				if (Date.now() - statSync(lock).mtimeMs > STALE_LOCK_MS) rmdirSync(lock);
			} catch {
				// A concurrent writer may have released the lock between stat and removal.
			}
			if (Date.now() >= deadline) throw new Error(`Timed out waiting for HAI companion ledger lock: ${lock}`);
			Atomics.wait(WAIT_ARRAY, 0, 0, LOCK_WAIT_MS);
		}
	}
}

function emptyOrParsedLedger(path: string, now: Date): Ledger {
	try {
		const value: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (value === null || typeof value !== "object") return emptyLedger(now);
		const source = value as Record<string, unknown>;
		if (source["version"] !== 1 || typeof source["day"] !== "string" || typeof source["month"] !== "string" || !isPeriod(source["daily"]) || !isPeriod(source["monthly"])) return emptyLedger(now);
		const baseline = isBaseline(source["baseline"]) ? source["baseline"] : undefined;
		const capHitAt = typeof source["capHitAt"] === "string" ? source["capHitAt"] : undefined;
		return rollLedger({ version: 1, day: source["day"], month: source["month"], daily: source["daily"], monthly: source["monthly"], baseline, capHitAt }, now);
	} catch {
		return emptyLedger(now);
	}
}

export function currentUtcPeriod(now = new Date()): Pick<Ledger, "day" | "month"> {
	return { day: now.toISOString().slice(0, 10), month: now.toISOString().slice(0, 7) };
}

export function emptyLedger(now = new Date()): Ledger {
	return { version: 1, ...currentUtcPeriod(now), daily: emptyPeriod(), monthly: emptyPeriod() };
}

export function loadLedger(path: string, now = new Date()): Ledger {
	return emptyOrParsedLedger(path, now);
}

export function rollLedger(ledger: Ledger, now = new Date()): Ledger {
	const current = currentUtcPeriod(now);
	const sameDay = ledger.day === current.day;
	const sameMonth = ledger.month === current.month;
	const baseline = ledger.baseline === undefined
		? undefined
		: {
			dailyEur: sameDay ? ledger.baseline.dailyEur : 0,
			monthlyEur: sameMonth ? ledger.baseline.monthlyEur : 0,
			capturedAt: ledger.baseline.capturedAt,
		};
	return {
		...ledger,
		day: current.day,
		month: current.month,
		daily: sameDay ? ledger.daily : emptyPeriod(),
		monthly: sameMonth ? ledger.monthly : emptyPeriod(),
		baseline,
		capHitAt: sameDay ? ledger.capHitAt : undefined,
	};
}

export function ledgerPath(): string {
	return join(getAgentDir(), "hai-proxy-companion.json");
}

export function saveLedger(path: string, ledger: Ledger): void {
	mkdirSync(dirname(path), { recursive: true });
	const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
	writeFileSync(temporary, `${JSON.stringify(ledger)}\n`, { encoding: "utf8", flag: "wx" });
	renameSync(temporary, path);
}

/** Applies one mutation while excluding other omp sessions sharing the ledger. */
export function updateLedger(path: string, update: (ledger: Ledger) => Ledger, now = new Date()): Ledger {
	mkdirSync(dirname(path), { recursive: true });
	acquireLock(path);
	try {
		const next = update(emptyOrParsedLedger(path, now));
		saveLedger(path, next);
		return next;
	} finally {
		try {
			rmdirSync(lockPath(path));
		} catch {
			// The lock is best-effort cleanup after a completed atomic write.
		}
	}
}

export function displayedEstimate(estimatedEur: number, baselineEur: number | undefined): number {
	return estimatedEur + (baselineEur ?? 0);
}

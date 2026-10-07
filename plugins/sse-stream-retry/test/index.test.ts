import { beforeEach, describe, expect, type Mock, mock, test } from "bun:test";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

const getPluginSettings = mock(async () => ({}));

mock.module("@oh-my-pi/pi-coding-agent/extensibility/plugins", () => ({ getPluginSettings }));

// The settings dependency must be mocked before loading the extension.
const { default: sseStreamRetry } = await import("../src/index.ts");

interface Context {
	setTimeout(callback: () => void, delay: number): void;
	ui: { notify(message: string, level: string): void };
}

type Handler = (event: Record<string, unknown>, ctx: Context) => unknown;

function makeContext(): Context {
	return {
		setTimeout: mock((callback: () => void, _delay: number) => callback()),
		ui: { notify: mock((_message: string, _level: string) => {}) },
	};
}

function makeApi() {
	const handlers = new Map<string, Handler>();
	const sendUserMessage = mock((_message: string) => {});
	const info = mock((_message: string) => {});
	const pi = {
		logger: { info },
		on(event: string, handler: Handler) {
			handlers.set(event, handler);
		},
		sendUserMessage,
	} as unknown as ExtensionAPI;
	sseStreamRetry(pi);
	return { handlers, info, sendUserMessage };
}

const SSE_ERROR = "Error while iterating over SSE stream. → aborted";

function failedTurn(errorMessage: unknown) {
	return { message: { role: "assistant", stopReason: "error", errorMessage } };
}

function successfulTurn() {
	return { message: { role: "assistant", stopReason: "stop" } };
}

async function start(handlers: Map<string, Handler>, context: Context) {
	await handlers.get("session_start")?.({}, context);
}

describe("sse-stream-retry", () => {
	beforeEach(() => {
		getPluginSettings.mockClear();
	});

	test("continues immediately on the first SSE abort", async () => {
		const { handlers, info, sendUserMessage } = makeApi();
		const context = makeContext();
		await start(handlers, context);

		handlers.get("turn_end")?.(failedTurn(SSE_ERROR), context);

		expect(sendUserMessage).toHaveBeenCalledWith(".");
		expect(context.ui.notify).toHaveBeenCalledWith(
			"SSE stream aborted. Auto-continuing in 0s (1/5)",
			"info",
		);
		expect(info).toHaveBeenCalledWith(
			"[sse-stream-retry] SSE stream aborted on attempt 1, continuing after 0ms",
		);
	});

	test("escalates the backoff on consecutive aborts", async () => {
		const { handlers } = makeApi();
		const context = makeContext();
		await start(handlers, context);
		const event = failedTurn(SSE_ERROR);

		for (let attempt = 0; attempt < 5; attempt++) handlers.get("turn_end")?.(event, context);

		const notify = context.ui.notify as unknown as Mock<(message: string, level: string) => void>;
		expect(notify.mock.calls.map((call) => call[0])).toEqual([
			"SSE stream aborted. Auto-continuing in 0s (1/5)",
			"SSE stream aborted. Auto-continuing in 1s (2/5)",
			"SSE stream aborted. Auto-continuing in 3s (3/5)",
			"SSE stream aborted. Auto-continuing in 5s (4/5)",
			"SSE stream aborted. Auto-continuing in 10s (5/5)",
		]);
	});

	test("gives up after the delay sequence is exhausted", async () => {
		const { handlers, sendUserMessage } = makeApi();
		const context = makeContext();
		await start(handlers, context);
		const event = failedTurn(SSE_ERROR);

		for (let attempt = 0; attempt < 6; attempt++) handlers.get("turn_end")?.(event, context);

		expect(sendUserMessage).toHaveBeenCalledTimes(5);
		expect(context.ui.notify).toHaveBeenLastCalledWith(
			"SSE stream aborted 5 times in a row. Giving up; continue manually or restart the turn.",
			"error",
		);
	});

	test("restarts the backoff after a recovered turn", async () => {
		const { handlers, sendUserMessage } = makeApi();
		const context = makeContext();
		await start(handlers, context);

		handlers.get("turn_end")?.(failedTurn(SSE_ERROR), context);
		handlers.get("turn_end")?.(failedTurn(SSE_ERROR), context);
		handlers.get("turn_end")?.(successfulTurn(), context);
		handlers.get("turn_end")?.(failedTurn(SSE_ERROR), context);

		expect(sendUserMessage).toHaveBeenCalledTimes(3);
		expect(context.ui.notify).toHaveBeenLastCalledWith(
			"SSE stream aborted. Auto-continuing in 0s (1/5)",
			"info",
		);
	});

	test("ignores errors that are not SSE aborts", async () => {
		const { handlers, sendUserMessage } = makeApi();
		const context = makeContext();
		await start(handlers, context);

		handlers.get("turn_end")?.(failedTurn("429 rate limited"), context);

		expect(sendUserMessage).not.toHaveBeenCalled();
		expect(context.ui.notify).not.toHaveBeenCalled();
	});

	test("does nothing when disabled", async () => {
		getPluginSettings.mockImplementationOnce(async () => ({ enabled: false }));
		const { handlers, sendUserMessage } = makeApi();
		const context = makeContext();
		await start(handlers, context);

		handlers.get("turn_end")?.(failedTurn(SSE_ERROR), context);

		expect(sendUserMessage).not.toHaveBeenCalled();
	});
});

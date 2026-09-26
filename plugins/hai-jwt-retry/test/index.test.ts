import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

const getPluginSettings = mock(async () => ({}));

mock.module("@oh-my-pi/pi-coding-agent/extensibility/plugins", () => ({ getPluginSettings }));

// The settings dependency must be mocked before loading the extension.
const { default: haiJwtRetry } = await import("../src/index.ts");

interface Context {
	models: { current: () => { baseUrl: string } };
	setTimeout(callback: () => void, delay: number): void;
	ui: { notify(message: string, level: string): void };
}

type Handler = (event: Record<string, unknown>, ctx: Context) => unknown;
function makeContext(baseUrl = "http://localhost:6655/openai/v1") {
	return {
		models: { current: () => ({ baseUrl }) },
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
		on(event: string, handler: Handler) { handlers.set(event, handler); },
		sendUserMessage,
	} as unknown as ExtensionAPI;
	haiJwtRetry(pi);
	return { handlers, info, sendUserMessage };
}

function failedTurn(errorMessage: unknown) {
	return {
		message: {
			role: "assistant",
			stopReason: "error",
			errorMessage,
		},
	};
}

function successfulTurn() {
	return {
		message: {
			role: "assistant",
			stopReason: "stop",
		},
	};
}

async function start(handlers: Map<string, Handler>, context: Context) {
	await handlers.get("session_start")?.({}, context);
}

describe("hai-jwt-retry", () => {
	beforeEach(() => {
		getPluginSettings.mockClear();
	});

	test("retries invalid encrypted reasoning responses", async () => {
		const { handlers, info, sendUserMessage } = makeApi();
		const context = makeContext();
		await start(handlers, context);

		handlers.get("turn_end")?.(failedTurn({
			message: "The encrypted content gAAA...yAD4 could not be verified. Reason: Encrypted content could not be decrypted or parsed.",
			code: "invalid_encrypted_content",
		}), context);

		expect(sendUserMessage).toHaveBeenCalledWith(".");
		expect(context.ui.notify).toHaveBeenCalledWith(
			"HAI proxy: encrypted reasoning rejected. Auto-retrying in 0s (1/3)",
			"info",
		);
		expect(info).toHaveBeenCalledWith(
			"[hai-jwt-retry] encrypted reasoning rejected on attempt 1, retrying after 0ms",
		);
	});

	test("keeps JWT expiry retries", async () => {
		const { handlers, sendUserMessage } = makeApi();
		const context = makeContext();
		await start(handlers, context);

		handlers.get("turn_end")?.(failedTurn("401 Jwt is expired"), context);

		expect(sendUserMessage).toHaveBeenCalledWith(".");
		expect(context.ui.notify).toHaveBeenCalledWith(
			"HAI proxy: JWT expired. Auto-retrying in 0s (1/3)",
			"info",
		);
	});

	test("stops after three consecutive retryable failures", async () => {
		const { handlers, sendUserMessage } = makeApi();
		const context = makeContext();
		await start(handlers, context);
		const event = failedTurn("invalid_encrypted_content");

		for (let attempt = 0; attempt < 4; attempt++) handlers.get("turn_end")?.(event, context);

		expect(sendUserMessage).toHaveBeenCalledTimes(3);
		expect(context.ui.notify).toHaveBeenLastCalledWith(
			"HAI proxy: encrypted reasoning was rejected 3 times in a row. Start a fresh session or switch back to the originating model.",
			"error",
		);
	});

	test("resets the retry limit after a successful turn", async () => {
		const { handlers } = makeApi();
		const context = makeContext();
		await start(handlers, context);

		handlers.get("turn_end")?.(failedTurn("invalid_encrypted_content"), context);
		handlers.get("turn_end")?.(failedTurn("invalid_encrypted_content"), context);
		handlers.get("turn_end")?.(successfulTurn(), context);
		handlers.get("turn_end")?.(failedTurn("invalid_encrypted_content"), context);

		expect(context.ui.notify).toHaveBeenLastCalledWith(
			"HAI proxy: encrypted reasoning rejected. Auto-retrying in 0s (1/3)",
			"info",
		);
	});

	test("ignores encrypted-content errors from other endpoints", async () => {
		const { handlers, sendUserMessage } = makeApi();
		const context = makeContext("https://api.openai.com/v1");
		await start(handlers, context);

		handlers.get("turn_end")?.(failedTurn("invalid_encrypted_content"), context);

		expect(sendUserMessage).not.toHaveBeenCalled();
		expect(context.ui.notify).not.toHaveBeenCalled();
	});
});

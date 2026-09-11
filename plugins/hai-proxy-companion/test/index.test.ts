import { beforeEach, describe, expect, mock, test } from "bun:test";
import { rmSync } from "node:fs";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

const getPluginSettings = mock(async () => ({}));
const getAgentDir = mock(() => "/tmp/hai-proxy-companion-test");

mock.module("@oh-my-pi/pi-coding-agent/extensibility/plugins", () => ({ getPluginSettings }));
mock.module("@oh-my-pi/pi-coding-agent", () => ({ getAgentDir }));

const { default: haiProxyCompanion } = await import("../src/index.ts");

type Context = ReturnType<typeof makeContext>;
type Handler = (event: Record<string, unknown>, ctx: Context) => unknown;

function makeContext() {
	return {
		hasUI: true,
		abort: mock(() => {}),
		shutdown: mock(() => {}),
		getContextUsage: mock(() => ({ tokens: 2_000, contextWindow: 200_000, percent: 1 })),
		models: {
			current: () => ({ baseUrl: "http://localhost:6655/anthropic", cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.25 } }),
			resolve: () => ({ baseUrl: "http://localhost:6655/anthropic", cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.25 } }),
		},
		ui: { notify: mock(() => {}), setWidget: mock(() => {}) },
	};
}

function makeApi() {
	const handlers = new Map<string, Handler>();
	const commands = new Map<string, (args: string, ctx: Context) => Promise<void>>();
	const pi = {
		on(event: string, handler: Handler) { handlers.set(event, handler); },
		registerCommand(name: string, command: { handler: (args: string, ctx: Context) => Promise<void> }) { commands.set(name, command.handler); },
	} as unknown as ExtensionAPI;
	haiProxyCompanion(pi);
	return { handlers, commands };
}

function finalMessage(overrides: Record<string, unknown> = {}) {
	return {
		role: "assistant",
		model: "anthropic--claude-4.5-haiku",
		usage: { input: 1_000, output: 100, cacheRead: 200, cacheWrite: 50, totalTokens: 1_350 },
		...overrides,
	};
}

describe("hai-proxy-companion lifecycle", () => {
	beforeEach(() => {
		getPluginSettings.mockClear();
		rmSync("/tmp/hai-proxy-companion-test/hai-proxy-companion.json", { force: true });
	});

	test("stops the harness on a HAI daily-cap response", async () => {
		const { handlers } = makeApi();
		const context = makeContext();
		await handlers.get("session_start")?.({}, context);
		handlers.get("after_provider_response")?.({ status: 402 }, context);
		expect(context.abort).toHaveBeenCalledTimes(1);
		expect(context.shutdown).toHaveBeenCalledTimes(1);
		expect(context.ui.notify).toHaveBeenCalledWith("HAI daily cap hit. The wallet has requested a lie-down.", "error");
	});

	test("ignores a 402 from a non-HAI provider", async () => {
		const { handlers } = makeApi();
		const context = makeContext();
		context.models.current = () => ({ baseUrl: "https://example.test", cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.25 } });
		await handlers.get("session_start")?.({}, context);
		handlers.get("after_provider_response")?.({ status: 402 }, context);
		expect(context.abort).not.toHaveBeenCalled();
		expect(context.shutdown).not.toHaveBeenCalled();
	});

	test("does not stop for a non-HAI daily-cap message", async () => {
		const { handlers } = makeApi();
		const context = makeContext();
		context.models.resolve = () => ({ baseUrl: "https://example.test", cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.25 } });
		await handlers.get("session_start")?.({}, context);
		handlers.get("turn_end")?.({ message: finalMessage({ errorMessage: "DAILY_CAP_EXCEEDED" }) }, context);
		expect(context.abort).not.toHaveBeenCalled();
		expect(context.shutdown).not.toHaveBeenCalled();
	});

	test("does not stop when companion is disabled", async () => {
		getPluginSettings.mockResolvedValueOnce({ enabled: false });
		const { handlers } = makeApi();
		const context = makeContext();
		await handlers.get("session_start")?.({}, context);
		handlers.get("after_provider_response")?.({ status: 402 }, context);
		expect(context.abort).not.toHaveBeenCalled();
		expect(context.shutdown).not.toHaveBeenCalled();
	});

	test("records one final completed turn without subscribing to message updates", async () => {
		const { handlers } = makeApi();
		const context = makeContext();
		await handlers.get("session_start")?.({}, context);
		expect(handlers.has("message_update")).toBe(false);
		handlers.get("turn_end")?.({ message: finalMessage() }, context);
		expect(context.ui.notify).not.toHaveBeenCalledWith(expect.stringContaining("daily cap"), "error");
		expect(context.ui.setWidget).toHaveBeenCalled();
	});

	test("removes and restores the footer as the active provider changes", async () => {
		const { handlers } = makeApi();
		const context = makeContext();
		await handlers.get("session_start")?.({}, context);
		const registeredWidget = context.ui.setWidget.mock.calls.at(-1) as unknown as readonly [string, unknown];
		expect(registeredWidget[0]).toBe("hai-proxy-companion");
		expect(typeof registeredWidget[1]).toBe("function");

		context.models.current = () => ({ baseUrl: "https://aicore.example.test", cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.25 } });
		handlers.get("turn_start")?.({}, context);
		expect(context.ui.setWidget).toHaveBeenLastCalledWith("hai-proxy-companion", undefined);

		context.models.current = () => ({ baseUrl: "http://localhost:6655/anthropic", cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.25 } });
		handlers.get("turn_start")?.({}, context);
		const restoredWidget = context.ui.setWidget.mock.calls.at(-1) as unknown as readonly [string, unknown];
		expect(restoredWidget[0]).toBe("hai-proxy-companion");
		expect(typeof restoredWidget[1]).toBe("function");
	});

	test("records an observable final HAI response cost", async () => {
		const { handlers, commands } = makeApi();
		const context = makeContext();
		await handlers.get("session_start")?.({}, context);
		handlers.get("turn_end")?.({ message: finalMessage({ usage: { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 1_000_000 } }) }, context);
		await commands.get("hai-status")?.("", context);
		expect(context.ui.notify).toHaveBeenCalledWith("HAI ~€1.00/50 today, ~€1.00/500 month.", "info");
	});

	test("warns once after crossing each configured daily threshold", async () => {
		getPluginSettings.mockResolvedValueOnce({ dailyBudgetEur: 0.001, warningPercentages: [50] });
		const { handlers } = makeApi();
		const context = makeContext();
		await handlers.get("session_start")?.({}, context);
		handlers.get("turn_end")?.({ message: finalMessage() }, context);
		handlers.get("turn_end")?.({ message: finalMessage() }, context);
		const notifications = context.ui.notify.mock.calls as unknown as readonly [string, string][];
		expect(notifications.filter(([message]) => message === "HAI estimate passed 50% of the daily budget.")).toHaveLength(1);
	});

	test("sets and clears a manual HAI TUI baseline", async () => {
		const { handlers, commands } = makeApi();
		const context = makeContext();
		await handlers.get("session_start")?.({}, context);
		await commands.get("hai-baseline")?.("4.5 27", context);
		expect(context.ui.notify).toHaveBeenCalledWith("HAI TUI baseline saved for this UTC day and month.", "info");
		await commands.get("hai-baseline")?.("clear", context);
		expect(context.ui.notify).toHaveBeenCalledWith("HAI TUI baseline cleared.", "info");
	});
});

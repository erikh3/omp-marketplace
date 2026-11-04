import { describe, expect, test } from "bun:test";
import type { ExtensionAPI, ExtensionContext, SessionStopEvent } from "@oh-my-pi/pi-coding-agent";

import speakNotifications from "../src/index.ts";

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;

function harness() {
	const handlers = new Map<string, Handler>();
	let speak: { handler: (args: string, ctx: ExtensionContext) => Promise<void> };
	const pi = {
		zod: { object: () => ({}), string: () => ({}) },
		on(name: string, handler: Handler) { handlers.set(name, handler); },
		registerMessageRenderer() {},
		registerCommand(_name: string, command: typeof speak) { speak = command; },
		sendMessage() {},
	} as unknown as ExtensionAPI;
	const ctx = { agent: { kind: "main" }, ui: { notify() {} }, isIdle: () => true } as unknown as ExtensionContext;
	speakNotifications(pi);
	const stop = { stop_hook_active: false } as SessionStopEvent;
	return {
		async enable() { await speak.handler("on", ctx); },
		async disable() { await speak.handler("off", ctx); },
		start() { handlers.get("before_agent_start")!({ systemPrompt: [] }, ctx); },
		work(toolName: string, isError = false, details?: unknown) { handlers.get("tool_result")!({ toolName, isError, details }, ctx); },
		stop(active = false) { return handlers.get("session_stop")!({ ...stop, stop_hook_active: active }, ctx); },
		context(messages: unknown[] = [], kind = "main") {
			return handlers.get("context")!({ messages }, { ...ctx, agent: { kind } } as ExtensionContext);
		},
	};
}

describe("completion notification decisions", () => {
	test("a substantial research task gets one optional completion check", async () => {
		const h = harness();
		try {
			await h.enable();
			h.start();
			for (let i = 0; i < 3; i++) h.work("read");
			expect(h.stop()).toMatchObject({ continue: true });
			expect(h.stop()).toBeUndefined();
			h.start();
			h.work("write");
			expect(h.stop(true)).toBeUndefined();
			expect(h.stop()).toMatchObject({ continue: true });
		} finally { await h.disable(); }
	});

	test("quick work and failed edits do not force an extra model turn", async () => {
		const h = harness();
		try {
			await h.enable();
			h.start();
			h.work("read");
			expect(h.stop()).toBeUndefined();
			h.start();
			h.work("edit", true);
			expect(h.stop()).toBeUndefined();
		} finally { await h.disable(); }
	});

	test("device execution through write is not a file mutation or speech work", async () => {
		const h = harness();
		try {
			await h.enable();
			h.start();
			h.work("write", false, { xdev: { tool: "mcp_lookup" } });
			expect(h.stop()).toBeUndefined();
			for (let i = 0; i < 3; i++) h.work("write", false, { xdev: { tool: "speak_notification" } });
			expect(h.stop()).toBeUndefined();
			h.work("write", false, { xdev: { tool: "mcp_lookup" } });
			h.work("write", false, { xdev: { tool: "mcp_lookup" } });
			expect(h.stop()).toMatchObject({ continue: true });
		} finally { await h.disable(); }
	});

	test("disabling suppresses completion even after substantial work", async () => {
		const h = harness();
		await h.enable();
		h.start();
		h.work("write");
		await h.disable();
		expect(h.stop()).toBeUndefined();
	});

	test("current state overrides restored notices without modifying history", async () => {
		const h = harness();
		const history = [{ role: "custom", customType: "speak-notifications-state", content: "disabled" }];
		try {
			await h.enable();
			expect(h.context(history)).toMatchObject({ messages: [...history, { content: expect.stringContaining("state: enabled") }] });
			expect(history).toHaveLength(1);
			await h.disable();
			expect(h.context()).toMatchObject({ messages: [{ content: expect.stringContaining("state: disabled") }] });
			expect(h.context([], "sub")).toBeUndefined();
		} finally { await h.disable(); }
	});
});

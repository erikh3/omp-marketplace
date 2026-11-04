import { describe, expect, spyOn, test } from "bun:test";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

import { COMPLETION_CHECK } from "../src/guidance.ts";
import speakNotifications from "../src/index.ts";

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;

function harness() {
	const handlers = new Map<string, Handler>();
	const sent: unknown[] = [];
	let speak: { handler: (args: string, ctx: ExtensionContext) => Promise<void> };
	const pi = {
		zod: { object: () => ({}), string: () => ({}) },
		on(name: string, handler: Handler) { handlers.set(name, handler); },
		registerMessageRenderer() {},
		registerCommand(_name: string, command: typeof speak) { speak = command; },
		sendMessage(message: unknown, options: unknown) { sent.push({ message, options }); },
	} as unknown as ExtensionAPI;
	const ctx = { agent: { kind: "main" }, ui: { notify() {} }, isIdle: () => true } as unknown as ExtensionContext;
	speakNotifications(pi);
	return {
		async enable() { await speak.handler("on", ctx); },
		async disable() { await speak.handler("off", ctx); },
		start() { handlers.get("before_agent_start")!({ systemPrompt: [] }, ctx); },
		work(toolName: string, isError = false, details?: unknown) { handlers.get("tool_result")!({ toolName, isError, details }, ctx); },
		settle() { return handlers.get("session_stop")?.({ stop_hook_active: false }, ctx); },
		context(messages: unknown[] = [], kind = "main") {
			return handlers.get("context")!({ messages }, { ...ctx, agent: { kind } } as ExtensionContext);
		},
		hasCheck(kind = "main") {
			const result = handlers.get("context")!({ messages: [] }, { ...ctx, agent: { kind } } as ExtensionContext);
			if (!result || typeof result !== "object" || !("messages" in result) || !Array.isArray(result.messages)) return false;
			return result.messages.some(message => typeof message.content === "string" && message.content.includes(COMPLETION_CHECK));
		},
		sent,
	};
}

describe("completion notification decisions", () => {
	test("substantial work gets one assessment before the final answer without a continuation", async () => {
		const h = harness();
		try {
			await h.enable();
			h.start();
			expect(h.hasCheck()).toBe(false);
			for (let i = 0; i < 2; i++) h.work("read");
			expect(h.hasCheck()).toBe(false);
			h.work("read");
			expect(h.hasCheck()).toBe(true);
			expect(h.hasCheck()).toBe(false);
			h.work("read");
			expect(h.hasCheck()).toBe(false);
			const notices = [...h.sent];
			expect(h.settle()).toBeUndefined();
			expect(h.sent).toEqual(notices);
			h.start();
			h.work("write");
			expect(h.hasCheck()).toBe(true);
		} finally { await h.disable(); }
	});

	test("only successful edits qualify immediately; speech does not count or reset assessment", async () => {
		const h = harness();
		try {
			await h.enable();
			h.start();
			h.work("edit", true);
			expect(h.hasCheck()).toBe(false);
			h.start();
			h.work("edit");
			h.work("speak_notification");
			expect(h.hasCheck()).toBe(true);
			h.work("speak_notification");
			expect(h.hasCheck()).toBe(false);
			h.start();
			for (let i = 0; i < 3; i++) h.work("speak_notification");
			expect(h.hasCheck()).toBe(false);
		} finally { await h.disable(); }
	});

	test("device execution is classified by the effective tool rather than write", async () => {
		const h = harness();
		try {
			await h.enable();
			h.start();
			h.work("write", false, { xdev: { tool: "mcp_lookup" } });
			expect(h.hasCheck()).toBe(false);
			for (let i = 0; i < 3; i++) h.work("write", false, { xdev: { tool: "speak_notification" } });
			expect(h.hasCheck()).toBe(false);
			h.work("write", false, { xdev: { tool: "mcp_lookup" } });
			h.work("write", false, { xdev: { tool: "mcp_lookup" } });
			expect(h.hasCheck()).toBe(true);
		} finally { await h.disable(); }
	});

	test("disabled sessions and subagent requests do not consume the primary assessment", async () => {
		const h = harness();
		try {
			await h.enable();
			h.start();
			h.work("write");
			expect(h.hasCheck("sub")).toBe(false);
			await h.disable();
			expect(h.hasCheck()).toBe(false);
			await h.enable();
			expect(h.hasCheck()).toBe(true);
			expect(h.hasCheck()).toBe(false);
		} finally { await h.disable(); }
	});

	test("elapsed time qualifies work at one minute but never qualifies an idle task", async () => {
		let now = 1_000;
		const clock = spyOn(Date, "now").mockImplementation(() => now);
		const h = harness();
		try {
			await h.enable();
			h.start();
			now += 60_000;
			expect(h.hasCheck()).toBe(false);
			h.start();
			h.work("read");
			now += 59_999;
			expect(h.hasCheck()).toBe(false);
			now++;
			expect(h.hasCheck()).toBe(true);
			expect(h.hasCheck()).toBe(false);
		} finally {
			await h.disable();
			clock.mockRestore();
		}
	});

	test("current state overrides restored notices without modifying history", async () => {
		const h = harness();
		const history = [{ role: "custom", customType: "speak-notifications-state", content: "disabled" }];
		try {
			await h.enable();
			expect(h.context(history)).toMatchObject({ messages: [...history, { content: expect.stringContaining("state: enabled") }] });
			expect(history).toEqual([{ role: "custom", customType: "speak-notifications-state", content: "disabled" }]);
			await h.disable();
			expect(h.context()).toMatchObject({ messages: [{ content: expect.stringContaining("state: disabled") }] });
			expect(h.context([], "sub")).toBeUndefined();
		} finally { await h.disable(); }
	});
});

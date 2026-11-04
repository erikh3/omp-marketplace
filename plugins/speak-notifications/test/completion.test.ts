import { describe, expect, mock, test } from "bun:test";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import * as zod from "@oh-my-pi/omptype/zod";

import { ReminderClock } from "../src/reminder-clock.ts";

let now = 0;
let clock: ReminderClock;
const timers: { at: number; callback: () => void; cancelled: boolean }[] = [];
mock.module("../src/reminder-clock.ts", () => ({
	ReminderClock: class extends ReminderClock {
		constructor() {
			super(1000, {
				now: () => now,
				setTimeout(callback, delayMs) {
					const timer = { at: now + delayMs, callback, cancelled: false };
					timers.push(timer);
					return timer;
				},
				clearTimeout(handle) { (handle as typeof timers[number]).cancelled = true; }
			});
			clock = this;
		}
	}
}));

// Install the deterministic clock before evaluating the extension.
const { default: speakNotifications } = await import("../src/index.ts");

function advance(milliseconds: number) {
	const target = now + milliseconds;
	for (;;) {
		const timer = timers.filter(timer => !timer.cancelled && timer.at <= target).sort((a, b) => a.at - b.at)[0];
		if (!timer) break;
		now = timer.at;
		timer.cancelled = true;
		timer.callback();
	}
	now = target;
}

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;

function harness() {
	const handlers = new Map<string, Handler>();
	let speak: { handler: (args: string, ctx: ExtensionContext) => Promise<void> };
	const sent: unknown[] = [];
	const pi = {
		zod,
		on(name: string, handler: Handler) { handlers.set(name, handler); },
		registerMessageRenderer() {},
		registerCommand(_name: string, command: typeof speak) { speak = command; },
		sendMessage(message: unknown) { sent.push(message); }
	} as unknown as ExtensionAPI;
	const ctx = { agent: { kind: "main" }, ui: { notify() {} }, getAsyncJobSnapshot: () => null } as unknown as ExtensionContext;
	speakNotifications(pi);
	return {
		async enable() { await speak.handler("on", ctx); },
		async disable() { await speak.handler("off", ctx); },
		start() {
			handlers.get("before_agent_start")!({ reason: "prompt", systemPrompt: [] }, ctx);
			handlers.get("agent_start")!({}, ctx);
		},
		work(name: string, isError = false) { handlers.get("tool_result")!({ toolName: name, isError }, ctx); },
		context() { return handlers.get("context")!({ messages: [] }, ctx) as { messages: { content: { text: string }[] }[] }; },
		call(input: Record<string, unknown>) { return handlers.get("tool_call")!({ toolName: "ask", input }, ctx); },
		event(name: string, event: unknown) { return handlers.get(name)?.(event, ctx); },
		settle(stopHookActive = false) { return handlers.get("session_stop")!({ stop_hook_active: stopHookActive }, ctx); },
		sent
	};
}

function contextText(result: { messages: { content: { text: string }[] }[] }) {
	return result.messages.at(-1)?.content[0]?.text ?? "";
}

describe("checkpoint lifecycle", () => {
	test("disabled work creates no outcome checkpoint or recovery", async () => {
		const h = harness();
		h.start();
		h.work("write");
		expect(contextText(h.context())).toContain("Speech: off.");
		expect(h.settle()).toBeUndefined();
		await h.disable();
	});

	test("context exposes but does not consume a pending outcome checkpoint", async () => {
		const h = harness();
		await h.enable();
		h.start();
		h.work("write");
		const first = contextText(h.context());
		const second = contextText(h.context());
		expect(first).toContain("checkpointId speech-");
		expect(second).toContain("checkpointId speech-");
		expect(second).toContain(first.match(/speech-[^ ]+/)?.[0] ?? "");
		await h.disable();
	});


	test("outcome recovery requests once then becomes unresolved", async () => {
		const h = harness();
		await h.enable();
		h.start();
		h.work("write");
		expect(h.settle()).toMatchObject({ continue: true });
		expect(h.settle(true)).toBeUndefined();
		expect(h.sent).toContainEqual(expect.objectContaining({ customType: "speak-notifications-unresolved" }));
		await h.disable();
	});
	test("delivers an expired timer instead of hiding it behind an optional outcome", async () => {
		const h = harness();
		try {
			await h.enable();
			h.start();
			h.event("turn_start", {});
			h.work("read");
			h.event("turn_end", {});
			advance(4000);
			expect(clock.peekReminder()).toBe(4000);
			h.event("turn_start", {});
			expect(contextText(h.context())).toContain("4 seconds of active work");
			expect(clock.peekReminder()).toBe(4000);
			h.event("turn_end", {});
			expect(clock.peekReminder()).toBeUndefined();
		} finally { await h.disable(); }
	});

	test("idle context inspection does not consume an expired background timer", async () => {
		const h = harness();
		try {
			await h.enable();
			clock.setWorking(true);
			advance(1000);
			expect(clock.peekReminder()).toBe(1000);
			h.context();
			h.event("turn_end", {});
			clock.setWorking(true);
			expect(clock.peekReminder()).toBe(1000);
		} finally { await h.disable(); }
	});

});

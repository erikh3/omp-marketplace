import { afterAll, describe, expect, mock, spyOn, test } from "bun:test";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@oh-my-pi/pi-coding-agent";
import * as zod from "@oh-my-pi/omptype/zod";

interface PlaybackControl {
	text: string;
	exited: Promise<void>;
	resolve(): void;
	stop(): Promise<void>;
}

const playbacks: PlaybackControl[] = [];

function createPlayback(text: string): PlaybackControl {
	const deferred = Promise.withResolvers<void>();
	const playback: PlaybackControl = {
		text,
		exited: deferred.promise,
		resolve: () => deferred.resolve(),
		stop: async () => deferred.resolve()
	};
	playbacks.push(playback);
	return playback;
}

mock.module("../src/playback.ts", () => ({ startLocalPlayback: (text: string) => createPlayback(text) }));
mock.module("@oh-my-pi/pi-coding-agent/config/model-resolver", () => ({
	resolveRoleChain: () => [{ model: { api: "local-inference", id: "local-test" } }]
}));
mock.module("@oh-my-pi/pi-coding-agent/config/model-roles", () => ({ roleCandidatePool: () => [] }));
mock.module("@oh-my-pi/pi-coding-agent/config/registry", () => ({
	lookup: (name: string) => ({ get: () => name === "tts.localVoice" ? "test" : 1 })
}));
mock.module("@oh-my-pi/pi-coding-agent/config/settings", () => ({ findScopedSettings: () => ({}) }));
mock.module("@oh-my-pi/pi-catalog/compat/behavior", () => ({ roleDefaultModels: () => ({ speech: [] }) }));

// The playback and host-setting mocks must exist before the extension loads.
const { default: speakNotifications } = await import("../src/index.ts");

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;
type ParametersWithParse = ToolDefinition["parameters"] & { parse(input: unknown): Record<string, unknown> };
type ToolResult = { details?: unknown };

function harness(agentKind = "main") {
	const handlers = new Map<string, Handler>();
	const messages: { customType?: string }[] = [];
	let tool: ToolDefinition | undefined;
	let command: { handler(args: string, ctx: ExtensionContext): Promise<void> } | undefined;
	const pi = {
		zod,
		on(name: string, handler: Handler) { handlers.set(name, handler); },
		registerTool(definition: ToolDefinition) { tool = definition; },
		registerMessageRenderer() {},
		registerCommand(_name: string, definition: NonNullable<typeof command>) { command = definition; },
		getActiveTools: () => ["ask", "xddevice", "speak_notification"],
		setActiveTools: async () => {},
		sendMessage(message: { customType?: string }) { messages.push(message); }
	} as unknown as ExtensionAPI;
	const ctx = {
		agent: { kind: agentKind },
		cwd: "/tmp",
		modelRegistry: {},
		models: { resolve: () => undefined },
		getAsyncJobSnapshot: () => null,
		ui: { notify() {} }
	} as unknown as ExtensionContext;
	speakNotifications(pi);
	return {
		messages,
		async start() { await handlers.get("session_start")?.({}, ctx); },
		async resume() { await handlers.get("session_switch")?.({}, ctx); },
		async enable() { await command?.handler("on", ctx); },
		async disable() { await command?.handler("off", ctx); },
		newPrompt() {
			handlers.get("before_agent_start")?.({ reason: "prompt", systemPrompt: [] }, ctx);
			handlers.get("agent_start")?.({}, ctx);
		},
		event(name: string, event: unknown) { return handlers.get(name)?.(event, ctx); },
		async execute(input: Record<string, unknown>) {
			if (!tool) throw new Error("Speech tool was not registered.");
			const params = (tool.parameters as ParametersWithParse).parse(input);
			return tool.execute("tool-call", params, undefined, undefined, ctx);
		},
		hasTool() { return tool !== undefined; }
	};
}

async function settlePlayback() {
	await Promise.resolve();
	await Promise.resolve();
}

async function finishAllPlaybacks(start: number) {
	for (let index = start; index < playbacks.length; index++) {
		playbacks[index].resolve();
		await settlePlayback();
	}
}

function spoken(result: ToolResult) {
	return result.details as { accepted?: boolean; suppressed?: boolean };
}

describe("registered speak_notification tool", () => {
	let now = 0;
	const nowSpy = spyOn(performance, "now");
	afterAll(() => { nowSpy.mockRestore(); });

	test("plays the agent-authored text exactly", async () => {
		nowSpy.mockReturnValue(now = 0);
		const baseline = playbacks.length;
		const h = harness();
		await h.start();
		await h.enable();
		const result = await h.execute({ purpose: "outcome", text: "Import completed with two warnings." });
		expect(spoken(result).accepted).toBe(true);
		await settlePlayback();
		expect(playbacks.slice(baseline).map(playback => playback.text)).toEqual(["Import completed with two warnings."]);
		await h.disable();
	});

	test("preserves the validated accepted text for playback", async () => {
		nowSpy.mockReturnValue(now = 0);
		const baseline = playbacks.length;
		const h = harness();
		await h.start();
		await h.enable();
		expect(spoken(await h.execute({ purpose: "outcome", text: "  The import completed.  " })).accepted).toBe(true);
		await settlePlayback();
		expect(playbacks.slice(baseline).map(playback => playback.text)).toEqual(["The import completed."]);
		await h.disable();
	});

	test("returns a non-error disabled response without queuing speech", async () => {
		const baseline = playbacks.length;
		const h = harness();
		await h.start();
		const result = await h.execute({ purpose: "outcome", text: "The deployment failed." });
		expect(result.isError).not.toBe(true);
		expect(spoken(result).accepted).toBe(false);
		await settlePlayback();
		expect(playbacks).toHaveLength(baseline);
	});

	test("does not spend a milestone interval on invalid text", async () => {
		nowSpy.mockReturnValue(now = 0);
		const baseline = playbacks.length;
		const h = harness();
		await h.start();
		await h.enable();
		expect((await h.execute({ purpose: "milestone", text: "   " })).isError).toBe(true);
		expect(spoken(await h.execute({ purpose: "milestone", text: "The migration reached validation." })).accepted).toBe(true);
		await settlePlayback();
		expect(playbacks.slice(baseline).map(playback => playback.text)).toEqual(["The migration reached validation."]);
		await h.disable();
	});

	test("does not spend duplicate or milestone gates when the queue rejects text", async () => {
		nowSpy.mockReturnValue(now = 0);
		const baseline = playbacks.length;
		const h = harness();
		await h.start();
		await h.enable();
		for (const text of ["One", "Two", "Three", "Four"]) expect(spoken(await h.execute({ purpose: "outcome", text })).accepted).toBe(true);
		nowSpy.mockReturnValue(now = 300_000);
		const rejected = await h.execute({ purpose: "milestone", text: "After capacity" });
		expect(rejected.isError).toBe(true);
		await finishAllPlaybacks(baseline);
		nowSpy.mockReturnValue(now = 300_001);
		expect(spoken(await h.execute({ purpose: "milestone", text: "After capacity" })).accepted).toBe(true);
		await h.disable();
	});

	test("accepts a milestone exactly five minutes after any accepted speech", async () => {
		nowSpy.mockReturnValue(now = 0);
		const h = harness();
		await h.start();
		await h.enable();
		expect(spoken(await h.execute({ purpose: "outcome", text: "Initial result." })).accepted).toBe(true);
		nowSpy.mockReturnValue(now = 299_999);
		expect(spoken(await h.execute({ purpose: "milestone", text: "Nearly ready." })).suppressed).toBe(true);
		nowSpy.mockReturnValue(now = 300_000);
		expect(spoken(await h.execute({ purpose: "milestone", text: "Ready now." })).accepted).toBe(true);
		await h.disable();
	});

	test("allows outcomes and attention without waiting for milestone spacing", async () => {
		nowSpy.mockReturnValue(now = 0);
		const h = harness();
		await h.start();
		await h.enable();
		expect(spoken(await h.execute({ purpose: "milestone", text: "Validated input." })).accepted).toBe(true);
		nowSpy.mockReturnValue(now = 1);
		expect(spoken(await h.execute({ purpose: "outcome", text: "The import failed." })).accepted).toBe(true);
		expect(spoken(await h.execute({ purpose: "attention", text: "Choose a target environment." })).accepted).toBe(true);
		await h.disable();
	});

	test("clears normalized duplicate text across purposes for a new prompt", async () => {
		const h = harness();
		await h.start();
		await h.enable();
		expect(spoken(await h.execute({ purpose: "outcome", text: "The report is ready." })).accepted).toBe(true);
		const duplicate = await h.execute({ purpose: "attention", text: "  The   report is ready.  " });
		expect(duplicate.isError).not.toBe(true);
		expect(spoken(duplicate)).toMatchObject({ accepted: false, suppressed: true });
		h.newPrompt();
		expect(spoken(await h.execute({ purpose: "attention", text: "The report is ready." })).accepted).toBe(true);
		await h.disable();
	});

	test("retains milestone spacing across a new prompt", async () => {
		nowSpy.mockReturnValue(now = 0);
		const h = harness();
		await h.start();
		await h.enable();
		expect(spoken(await h.execute({ purpose: "milestone", text: "Validated input." })).accepted).toBe(true);
		h.newPrompt();
		nowSpy.mockReturnValue(now = 1);
		expect(spoken(await h.execute({ purpose: "milestone", text: "Prepared output." }))).toMatchObject({ accepted: false, suppressed: true });
		await h.disable();
	});

	test("resets duplicate and frequency gates when disabled, enabled, or resumed", async () => {
		nowSpy.mockReturnValue(now = 0);
		const h = harness();
		await h.start();
		await h.enable();
		expect(spoken(await h.execute({ purpose: "milestone", text: "Checkpoint reached." })).accepted).toBe(true);
		await h.disable();
		await h.enable();
		expect(spoken(await h.execute({ purpose: "milestone", text: "Checkpoint reached." })).accepted).toBe(true);
		await h.resume();
		await h.enable();
		expect(spoken(await h.execute({ purpose: "milestone", text: "Checkpoint reached." })).accepted).toBe(true);
		await h.disable();
	});

	test("registers only for the main agent", async () => {
		const h = harness("subagent");
		await h.start();
		expect(h.hasTool()).toBe(false);
	});

	test("never blocks ask or xddevice calls and emits no settlement recovery messages", async () => {
		const h = harness();
		await h.start();
		await h.enable();
		expect(h.event("tool_call", { toolName: "ask", input: { questions: [] } })).toBeUndefined();
		expect(h.event("tool_call", { toolName: "xddevice", input: { name: "pick" } })).toBeUndefined();
		expect(h.event("tool_approval_requested", { toolName: "ask" })).toBeUndefined();
		expect(h.messages.filter(message => message.customType?.includes("recovery") || message.customType?.includes("unresolved"))).toEqual([]);
		await h.disable();
	});
});

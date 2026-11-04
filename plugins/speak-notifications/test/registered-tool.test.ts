import { describe, expect, mock, test } from "bun:test";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@oh-my-pi/pi-coding-agent";
import * as zod from "@oh-my-pi/omptype/zod";

interface PlaybackControl {
	exited: Promise<void>;
	stop(): Promise<void>;
	resolve(): void;
}

const playbacks: PlaybackControl[] = [];

function createPlayback(): PlaybackControl {
	const deferred = Promise.withResolvers<void>();
	const playback: PlaybackControl = {
		exited: deferred.promise,
		stop: async () => { deferred.resolve(); },
		resolve: () => { deferred.resolve(); }
	};
	playbacks.push(playback);
	return playback;
}

mock.module("../src/playback.ts", () => ({ startLocalPlayback: () => createPlayback() }));
mock.module("@oh-my-pi/pi-coding-agent/config/model-resolver", () => ({
	resolveRoleChain: () => [{ model: { api: "local-inference", id: "local-test" } }]
}));
mock.module("@oh-my-pi/pi-coding-agent/config/model-roles", () => ({ roleCandidatePool: () => [] }));
mock.module("@oh-my-pi/pi-coding-agent/config/registry", () => ({
	lookup: (name: string) => ({ get: () => name === "tts.localVoice" ? "test" : 1 })
}));
mock.module("@oh-my-pi/pi-coding-agent/config/settings", () => ({ findScopedSettings: () => ({}) }));
mock.module("@oh-my-pi/pi-catalog/compat/behavior", () => ({ roleDefaultModels: () => ({ speech: [] }) }));

// The mocks must be installed before this extension is evaluated.
const { default: speakNotifications } = await import("../src/index.ts");

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;
type ContextResult = { messages: { content: { text: string }[] }[] };
type ParametersWithParse = ToolDefinition["parameters"] & { parse(input: unknown): Record<string, unknown> };
const question = { questions: [{ id: "delete", question: "Delete the release?", options: [{ label: "Delete" }, { label: "Keep" }] }] };

function harness() {
	const handlers = new Map<string, Handler>();
	let tool: ToolDefinition;
	let command: { handler(args: string, ctx: ExtensionContext): Promise<void> };
	const messages: { customType?: string }[] = [];
	const pi = {
		zod,
		on(name: string, handler: Handler) { handlers.set(name, handler); },
		registerTool(definition: ToolDefinition) { tool = definition; },
		registerMessageRenderer() {},
		registerCommand(_name: string, definition: typeof command) { command = definition; },
		getActiveTools: () => ["ask", "bash", "plannotator", "speak_notification"],
		setActiveTools: async () => {},
		sendMessage(message: { customType?: string }) { messages.push(message); }
	} as unknown as ExtensionAPI;
	const ctx = {
		agent: { kind: "main" }, cwd: "/tmp", modelRegistry: {}, models: { resolve: () => undefined },
		getAsyncJobSnapshot: () => null, ui: { notify() {} }
	} as unknown as ExtensionContext;
	speakNotifications(pi);
	return {
		messages,
		async start() { await handlers.get("session_start")!({}, ctx); },
		async enable() { await command.handler("on", ctx); },
		async disable() { await command.handler("off", ctx); },
		startTurn() { handlers.get("agent_start")!({}, ctx); },
		startStep() { handlers.get("turn_start")!({}, ctx); },
		shutdown() { return handlers.get("session_shutdown")!({}, ctx); },
		endAgent(event: unknown = { messages: [] }) { return handlers.get("agent_end")!(event, ctx); },
		beforeStart(systemPrompt: string[]) { return handlers.get("before_agent_start")!({ reason: "prompt", systemPrompt }, ctx); },
		outcome() { handlers.get("before_agent_start")!({ reason: "prompt", systemPrompt: [] }, ctx); handlers.get("tool_result")!({ toolName: "write", isError: false }, ctx); },
		checkpointId() {
			const result = handlers.get("context")!({ messages: [] }, ctx) as ContextResult;
			return (result.messages.at(-1)?.content[0]?.text ?? "").match(/checkpointId (speech-[^ .]+)/)?.[1];
		},
		async execute(input: Record<string, unknown>) {
			const params = (tool.parameters as ParametersWithParse).parse(input);
			return tool.execute("tool-call", params, undefined, undefined, ctx);
		},
		event(name: string, event: unknown) { return handlers.get(name)?.(event, ctx); }
	};
}

async function settleWorker() { await Promise.resolve(); await Promise.resolve(); }

describe("registered speak_notification tool", () => {
	test("rejects a stale identifier without starting playback", async () => {
		const baseline = playbacks.length;
		const h = harness();
		try {
			await h.start();
			await h.enable();
			const result = await h.execute({ action: "speak", purpose: "outcome", checkpointId: "speech-stale", text: "Finished." });
			expect(result.isError).toBe(true);
			await settleWorker();
			expect(playbacks).toHaveLength(baseline);
		} finally { await h.disable(); }
	});

	test("does not override the host policy on repeated prompt starts", async () => {
		const h = harness();
		await h.start();
		expect(h.beforeStart([])).toBeUndefined();
		expect(h.beforeStart([])).toBeUndefined();
		await h.disable();
	});

	test("accepts one outcome speech decision and makes its resolved identifier idempotent", async () => {
		const baseline = playbacks.length;
		const h = harness();
		try {
			await h.start();
			await h.enable();
			h.outcome();
			const checkpointId = h.checkpointId();
			expect(checkpointId).toBeDefined();
			const speak = { action: "speak", purpose: "outcome", checkpointId, text: "The update finished." };
			expect((await h.execute(speak)).isError).not.toBe(true);
			expect((await h.execute(speak)).isError).not.toBe(true);
			await settleWorker();
			expect(playbacks).toHaveLength(baseline + 1);
		} finally { await h.disable(); }
	});

	test("does not enqueue speech after a silent outcome decision", async () => {
		const baseline = playbacks.length;
		const h = harness();
		try {
			await h.start();
			await h.enable();
			h.outcome();
			const checkpointId = h.checkpointId();
			expect((await h.execute({ action: "silent", purpose: "outcome", checkpointId, reason: "Nothing useful to announce." })).isError).not.toBe(true);
			expect((await h.execute({ action: "speak", purpose: "outcome", checkpointId, text: "This must not queue." })).isError).not.toBe(true);
			await settleWorker();
			expect(playbacks).toHaveLength(baseline);
		} finally { await h.disable(); }
	});

	test("creates a new outcome identifier for material returned background evidence", async () => {
		const h = harness();
		try {
			await h.start();
			await h.enable();
			h.outcome();
			const first = h.checkpointId();
			expect((await h.execute({ action: "silent", purpose: "outcome", checkpointId: first, reason: "No announcement is useful." })).isError).not.toBe(true);
			h.event("message_end", { message: { role: "custom", customType: "async-result" } });
			expect(h.checkpointId()).not.toBe(first);
		} finally { await h.disable(); }
	});

	test("keeps an outcome pending when its speech text is rejected", async () => {
		const baseline = playbacks.length;
		const h = harness();
		try {
			await h.start();
			await h.enable();
			h.outcome();
			const checkpointId = h.checkpointId();
			expect((await h.execute({ action: "speak", purpose: "outcome", checkpointId, text: "" })).isError).toBe(true);
			expect(h.checkpointId()).toBe(checkpointId);
			await settleWorker();
			expect(playbacks).toHaveLength(baseline);
		} finally { await h.disable(); }
	});

	test("offers a valid outcome identifier after one work result without requiring recovery", async () => {
		const baseline = playbacks.length;
		const h = harness();
		try {
			await h.start();
			await h.enable();
			h.beforeStart([]);
			h.startTurn();
			h.event("tool_result", { toolName: "read", isError: false });
			const checkpointId = h.checkpointId();
			expect(checkpointId).toBeDefined();
			h.endAgent({ messages: [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "The requested field is absent." }] }] });
			expect(h.messages.filter(message => message.customType === "speak-notifications-outcome-recovery")).toHaveLength(0);
			expect((await h.execute({ action: "speak", purpose: "outcome", checkpointId, text: "The requested field is absent." })).isError).not.toBe(true);
			await settleWorker();
			expect(playbacks).toHaveLength(baseline + 1);
		} finally { await h.disable(); }
	});

	test("does not accept an outcome checkpoint for attention", async () => {
		const h = harness();
		try {
			await h.start();
			await h.enable();
			h.beforeStart([]);
			h.startTurn();
			h.event("tool_result", { toolName: "read", isError: false });
			const checkpointId = h.checkpointId();
			const result = await h.execute({ action: "silent", purpose: "attention", checkpointId, reason: "No audio needed." });
			expect(result.isError).toBe(true);
			expect(result.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("outcome checkpoint") });
		} finally { await h.disable(); }
	});

	test("promotes the optional outcome identifier when work qualifies", async () => {
		const h = harness();
		try {
			await h.start();
			await h.enable();
			h.beforeStart([]);
			h.startTurn();
			h.event("tool_result", { toolName: "read", isError: false });
			const checkpointId = h.checkpointId();
			h.event("tool_result", { toolName: "write", isError: false });
			expect(h.checkpointId()).toBe(checkpointId);
			expect(h.endAgent({ messages: [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Updated the file." }] }] })).toBeUndefined();
			expect(h.messages.filter(message => message.customType === "speak-notifications-outcome-recovery")).toHaveLength(1);
		} finally { await h.disable(); }
	});

	test("schedules one recovery only after a terminal textual outcome", async () => {
		const h = harness();
		try {
			await h.start();
			await h.enable();
			h.outcome();
			h.endAgent({ messages: [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Completed the maintenance task." }] }] });
			expect(h.messages.filter(message => message.customType === "speak-notifications-outcome-recovery")).toHaveLength(1);
			h.endAgent({ messages: [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "No additional result." }] }] });
			expect(h.messages.filter(message => message.customType === "speak-notifications-unresolved")).toHaveLength(1);
		} finally { await h.disable(); }
	});


	test("covers only an unchanged proactive attention target", async () => {
		const h = harness();
		try {
			await h.start();
			await h.enable();
			const boundary = { kind: "tool", toolName: "ask", input: question };
			expect((await h.execute({ action: "silent", purpose: "attention", boundary, reason: "The prompt is self-explanatory." })).isError).not.toBe(true);
			expect(h.event("tool_call", { toolName: "ask", input: question })).toBeUndefined();
			h.event("tool_execution_start", { toolCallId: "first", toolName: "ask", args: question });
			h.event("tool_execution_end", { toolCallId: "first", toolName: "ask" });
			const revised = { questions: [{ ...question.questions[0], options: [{ label: "Delete" }, { label: "Later" }] }] };
			expect(h.event("tool_call", { toolName: "ask", input: revised })).toMatchObject({ block: true });
		} finally { await h.disable(); }
	});

	test("uses exact proactive coverage for a later approval", async () => {
		const h = harness();
		try {
			await h.start();
			await h.enable();
			const input = { command: "git push" };
			const boundary = { kind: "tool", toolName: "bash", input };
			expect((await h.execute({ action: "silent", purpose: "attention", boundary, reason: "The approval prompt is sufficient." })).isError).not.toBe(true);
			h.event("tool_execution_start", { toolCallId: "approval-covered", toolName: "bash", args: input });
			expect(h.event("tool_approval_requested", { toolCallId: "approval-covered", toolName: "bash" })).toBeUndefined();
			expect(h.messages.filter(message => message.customType === "speak-notifications-unresolved")).toHaveLength(0);
		} finally { await h.disable(); }
	});

	test("records uncovered approval and native review without blocking their host waits", async () => {
		const h = harness();
		try {
			await h.start();
			await h.enable();
			h.event("tool_execution_start", { toolCallId: "approval", toolName: "bash", args: { command: "git push" } });
			expect(h.event("tool_approval_requested", { toolCallId: "approval", toolName: "bash" })).toBeUndefined();
			expect(h.event("plan_review_requested", { reviewId: "review", planFilePath: "plan.md", planContent: "# Plan" })).toBeUndefined();
			expect(h.messages.filter(message => message.customType === "speak-notifications-unresolved")).toHaveLength(2);
		} finally { await h.disable(); }
	});

	test("releases an intercepted nested ask after its recovery response omits a decision", async () => {
		const h = harness();
		try {
			await h.start();
			await h.enable();
			h.startStep();
			h.event("tool_execution_start", { toolCallId: "nested", toolName: "write", args: { path: "plan.md", content: "Draft" } });
			const blocked = h.event("tool_call", { toolCallId: "nested", toolName: "ask", input: question });
			expect(blocked).toMatchObject({ block: true });
			h.event("tool_execution_end", { toolCallId: "nested", toolName: "write" });
			h.event("turn_end", {});
			h.startStep();
			expect(h.event("tool_call", { toolCallId: "resubmitted", toolName: "ask", input: question })).toBeUndefined();
			expect(h.messages.filter(message => message.customType === "speak-notifications-unresolved")).toHaveLength(1);
			expect(h.event("tool_call", { toolCallId: "later", toolName: "ask", input: question })).toBeUndefined();
			expect(h.messages.filter(message => message.customType === "speak-notifications-unresolved")).toHaveLength(1);
		} finally { await h.disable(); }
	});

	test("keeps an accepted nested ask recovery valid after the outer call ends", async () => {
		const h = harness();
		try {
			await h.start();
			await h.enable();
			h.startStep();
			h.event("tool_execution_start", { toolCallId: "nested", toolName: "write", args: { path: "plan.md", content: "Draft" } });
			const blocked = h.event("tool_call", { toolCallId: "nested", toolName: "ask", input: question }) as { reason?: string };
			expect(blocked).toMatchObject({ block: true });
			h.event("tool_execution_end", { toolCallId: "nested", toolName: "write" });
			h.event("turn_end", {});
			h.startStep();
			const checkpointId = blocked.reason?.match(/speech-[^ .]+/)?.[0];
			expect((await h.execute({ action: "silent", purpose: "attention", checkpointId, reason: "The question is clear." })).isError).not.toBe(true);
			expect(h.event("tool_call", { toolCallId: "resubmitted", toolName: "ask", input: question })).toBeUndefined();
			expect(h.messages.filter(message => message.customType === "speak-notifications-unresolved")).toHaveLength(0);
		} finally { await h.disable(); }
	});

	test("keeps an accepted nested plan review recovery valid after the outer call ends", async () => {
		const h = harness();
		const review = { action: "review", planFilePath: "plan.md", planContent: "# Plan" };
		try {
			await h.start();
			await h.enable();
			h.startStep();
			h.event("tool_execution_start", { toolCallId: "nested", toolName: "write", args: { path: "plan.md", content: "Draft" } });
			const blocked = h.event("tool_call", { toolCallId: "nested", toolName: "plannotator", input: review }) as { reason?: string };
			expect(blocked).toMatchObject({ block: true });
			h.event("tool_execution_end", { toolCallId: "nested", toolName: "write" });
			h.event("turn_end", {});
			h.startStep();
			const checkpointId = blocked.reason?.match(/speech-[^ .]+/)?.[0];
			expect((await h.execute({ action: "silent", purpose: "attention", checkpointId, reason: "The review can proceed." })).isError).not.toBe(true);
			expect(h.event("tool_call", { toolCallId: "resubmitted", toolName: "plannotator", input: review })).toBeUndefined();
		} finally { await h.disable(); }
	});

	test("preserves pending coverage through a continuing aborted agent", async () => {
		const baseline = playbacks.length;
		const h = harness();
		try {
			await h.start();
			await h.enable();
			h.outcome();
			const checkpointId = h.checkpointId();
			h.endAgent({ willContinue: true, messages: [{ role: "assistant", stopReason: "aborted", content: [] }] });
			expect((await h.execute({ action: "speak", purpose: "outcome", checkpointId, text: "The work completed." })).isError).not.toBe(true);
			await settleWorker();
			expect(playbacks).toHaveLength(baseline + 1);
		} finally { await h.disable(); }
	});

	test("invalidates pending coverage after a terminal aborted agent", async () => {
		const h = harness();
		try {
			await h.start();
			await h.enable();
			h.outcome();
			const checkpointId = h.checkpointId();
			h.endAgent({ willContinue: false, messages: [{ role: "assistant", stopReason: "aborted", content: [] }] });
			expect((await h.execute({ action: "silent", purpose: "outcome", checkpointId, reason: "No announcement is useful." })).isError).toBe(true);
		} finally { await h.disable(); }
	});

	test("does not recover a completed async result after a new routine task begins", async () => {
		const h = harness();
		try {
			await h.start();
			await h.enable();
			h.event("message_end", { message: { role: "custom", customType: "async-result" } });
			h.beforeStart([]);
			h.startTurn();
			h.event("tool_result", { toolName: "read", isError: false });
			h.endAgent({ messages: [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "The requested field is absent." }] }] });
			expect(h.messages.filter(message => message.customType === "speak-notifications-outcome-recovery")).toHaveLength(0);
		} finally { await h.disable(); }
	});

	test("rejects silent decisions for unresolved attention without playback", async () => {
		const baseline = playbacks.length;
		const h = harness();
		try {
			await h.start();
			await h.enable();
			h.startStep();
			const blocked = h.event("tool_call", { toolCallId: "blocked", toolName: "ask", input: question }) as { reason?: string };
			expect(blocked).toMatchObject({ block: true });
			h.event("tool_execution_start", { toolCallId: "blocked", toolName: "ask", args: question });
			h.event("turn_end", {});
			h.startStep();
			h.event("turn_end", {});
			const checkpointId = blocked.reason?.match(/speech-[^ .]+/)?.[0];
			expect((await h.execute({ action: "silent", purpose: "attention", checkpointId, reason: "Too late to decide." })).isError).toBe(true);
			await settleWorker();
			expect(playbacks).toHaveLength(baseline);
			expect(h.event("tool_call", { toolCallId: "released", toolName: "ask", input: question })).toBeUndefined();
			expect(h.messages.filter(message => message.customType === "speak-notifications-unresolved")).toHaveLength(1);
		} finally { await h.disable(); }
	});

	test("shuts down an active registered-tool playback", async () => {
		const baseline = playbacks.length;
		const h = harness();
		await h.start();
		await h.enable();
		h.outcome();
		const checkpointId = h.checkpointId();
		expect((await h.execute({ action: "speak", purpose: "outcome", checkpointId, text: "Finishing now." })).isError).not.toBe(true);
		await settleWorker();
		expect(playbacks).toHaveLength(baseline + 1);
		await h.shutdown();
	});
	test("rejects a proactive speech decision when checkpoint admission is full", async () => {
		const baseline = playbacks.length;
		const h = harness();
		try {
			await h.start();
			await h.enable();
			for (let index = 0; index < 16; index++) {
				const boundary = { kind: "tool", toolName: "ask", input: { questions: [{ ...question.questions[0], id: `delete-${index}` }] } };
				expect((await h.execute({ action: "silent", purpose: "attention", boundary, reason: "No audio needed." })).isError).not.toBe(true);
			}
			const boundary = { kind: "tool", toolName: "ask", input: { questions: [{ ...question.questions[0], id: "delete-overflow" }] } };
			expect((await h.execute({ action: "speak", purpose: "attention", boundary, text: "Do not queue." })).isError).toBe(true);
			await settleWorker();
			expect(playbacks).toHaveLength(baseline);
		} finally { await h.disable(); }
	});
});


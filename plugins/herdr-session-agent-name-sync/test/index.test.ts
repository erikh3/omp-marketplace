import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { ExecResult, ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

import herdrSessionAgentNameSync, {
	collisionSafeAgentName,
	sessionTitleToAgentName,
} from "../src/index.ts";

type Handler = (event: unknown, ctx: ExtensionContext) => Promise<unknown> | unknown;
type TimerCallback = () => Promise<unknown> | unknown;

interface ExecCall {
	command: string;
	args: string[];
}

interface FakeManager {
	getSessionId(): string;
	getSessionName(): string | undefined;
	onSessionNameChanged?(callback: () => unknown): () => void;
	setName(name: string | undefined): Promise<void>;
	listenerCount(): number;
}

const originalHerdrEnv = process.env.HERDR_ENV;
const originalHerdrPaneId = process.env.HERDR_PANE_ID;

function execResult(code = 0, stderr = ""): ExecResult {
	return { stdout: "", stderr, code, killed: false };
}

function makeManager(name: string | undefined, sessionId = "01a0dedc-7b9d-7661-8485-71a029b7e767", observable = true): FakeManager {
	let currentName = name;
	const listeners = new Set<() => unknown>();
	const manager: FakeManager = {
		getSessionId: () => sessionId,
		getSessionName: () => currentName,
		setName: async nextName => {
			currentName = nextName;
			await Promise.all([...listeners].map(listener => Promise.resolve(listener())));
		},
		listenerCount: () => listeners.size,
	};
	if (observable) {
		manager.onSessionNameChanged = callback => {
			listeners.add(callback);
			return () => listeners.delete(callback);
		};
	}
	return manager;
}

function makeContext(manager: FakeManager, kind: "main" | "sub" = "main") {
	let intervalCallback: TimerCallback | undefined;
	const clearTimer = mock(() => undefined);
	const context = {
		agent: { kind, id: "agent-1", name: kind, depth: kind === "main" ? 0 : 1 },
		sessionManager: manager,
		setInterval: (callback: TimerCallback): Timer => {
			intervalCallback = callback;
			return 1 as unknown as Timer;
		},
		clearTimer,
	} as unknown as ExtensionContext;
	return {
		context,
		clearTimer,
		runInterval: async () => intervalCallback?.(),
	};
}

function makeHarness(results: ExecResult[] = []) {
	const handlers = new Map<string, Handler>();
	const calls: ExecCall[] = [];
	const warnings: unknown[][] = [];
	const exec = mock(async (command: string, args: string[]): Promise<ExecResult> => {
		calls.push({ command, args });
		return results.shift() ?? execResult();
	});
	const pi = {
		exec,
		logger: {
			warn: (...args: unknown[]) => warnings.push(args),
		},
		on: (event: string, handler: Handler) => handlers.set(event, handler),
	} as unknown as ExtensionAPI;
	herdrSessionAgentNameSync(pi);
	return { calls, handlers, warnings };
}

async function fire(handlers: Map<string, Handler>, event: string, context: ExtensionContext): Promise<void> {
	const handler = handlers.get(event);
	if (!handler) throw new Error(`${event} handler not registered`);
	await handler({ type: event }, context);
}

beforeEach(() => {
	process.env.HERDR_ENV = "1";
	process.env.HERDR_PANE_ID = "w2Y:p1";
});

afterEach(() => {
	if (originalHerdrEnv === undefined) delete process.env.HERDR_ENV;
	else process.env.HERDR_ENV = originalHerdrEnv;
	if (originalHerdrPaneId === undefined) delete process.env.HERDR_PANE_ID;
	else process.env.HERDR_PANE_ID = originalHerdrPaneId;
});

describe("session title conversion", () => {
	test("produces the Herdr name used for a normal title", () => {
		expect(sessionTitleToAgentName("Herdr OMP Agent Name Plugin", "session-id")).toBe(
			"herdr-omp-agent-name-plugin",
		);
	});

	test("normalizes accents, leading digits, and the length limit", () => {
		expect(sessionTitleToAgentName("42 Déjà Vu Sessions With A Very Long Tail", "session-id")).toBe(
			"session-42-deja-vu-sessions-with",
		);
	});

	test("falls back to the session id when the title has no valid characters", () => {
		expect(sessionTitleToAgentName("日本語", "01a0dedc-7b9d")).toBe("omp-01a0dedc");
	});

	test("adds a valid bounded pane-specific collision suffix", () => {
		const name = collisionSafeAgentName("a-very-long-session-name-that-collides", "w2Y:p1");
		expect(name.length).toBeLessThanOrEqual(32);
		expect(name).toMatch(/^[a-z][a-z0-9-]*-w2yp1$/);
	});
});

describe("Herdr synchronization", () => {
	test("renames the current pane when the main session starts", async () => {
		const harness = makeHarness();
		const { context } = makeContext(makeManager("Herdr OMP Agent Name Plugin"));
		await fire(harness.handlers, "session_start", context);
		expect(harness.calls).toEqual([
			{
				command: "herdr",
				args: ["agent", "rename", "w2Y:p1", "herdr-omp-agent-name-plugin"],
			},
		]);
	});

	test("reacts to every session title change", async () => {
		const manager = makeManager("Initial Session");
		const harness = makeHarness();
		const { context } = makeContext(manager);
		await fire(harness.handlers, "session_start", context);
		harness.calls.length = 0;

		await manager.setName("Renamed Session");
		expect(harness.calls).toEqual([
			{ command: "herdr", args: ["agent", "rename", "w2Y:p1", "renamed-session"] },
		]);
	});

	test("preserves an assigned Herdr name until omp has a title", async () => {
		const manager = makeManager(undefined);
		const harness = makeHarness();
		const { context } = makeContext(manager);
		await fire(harness.handlers, "session_start", context);
		expect(harness.calls).toEqual([]);

		await manager.setName("First Session Title");
		expect(harness.calls[0]?.args).toEqual(["agent", "rename", "w2Y:p1", "first-session-title"]);
	});

	test("clears a stale Herdr name when switching to an unnamed omp session", async () => {
		const harness = makeHarness();
		const { context } = makeContext(makeManager(undefined));
		await fire(harness.handlers, "session_switch", context);
		expect(harness.calls[0]?.args).toEqual(["agent", "rename", "w2Y:p1", "--clear"]);
	});

	test("rebinds observation after a session switch", async () => {
		const first = makeManager("First Session", "first-id");
		const second = makeManager("Second Session", "second-id");
		const harness = makeHarness();
		await fire(harness.handlers, "session_start", makeContext(first).context);
		await fire(harness.handlers, "session_switch", makeContext(second).context);
		expect(first.listenerCount()).toBe(0);
		expect(second.listenerCount()).toBe(1);
		harness.calls.length = 0;

		await first.setName("Ignored Old Session");
		await second.setName("Active New Session");
		expect(harness.calls).toEqual([
			{ command: "herdr", args: ["agent", "rename", "w2Y:p1", "active-new-session"] },
		]);
	});

	test("ignores internal subagent sessions", async () => {
		const harness = makeHarness();
		const manager = makeManager("Subagent Session");
		await fire(harness.handlers, "session_start", makeContext(manager, "sub").context);
		expect(harness.calls).toEqual([]);
		expect(manager.listenerCount()).toBe(0);
	});

	test("polls through the public API when the title callback is unavailable", async () => {
		const harness = makeHarness();
		const manager = makeManager("Initial Session", "session-id", false);
		const context = makeContext(manager);
		await fire(harness.handlers, "session_start", context.context);
		harness.calls.length = 0;

		await manager.setName("Polled Session");
		await context.runInterval();
		expect(harness.calls).toEqual([
			{ command: "herdr", args: ["agent", "rename", "w2Y:p1", "polled-session"] },
		]);
	});

	test("retries a rejected title with a pane-specific name", async () => {
		const harness = makeHarness([execResult(1, "name already in use"), execResult()]);
		const { context } = makeContext(makeManager("Duplicate Session"));
		await fire(harness.handlers, "session_start", context);
		expect(harness.calls.map(call => call.args.at(-1))).toEqual(["duplicate-session", "duplicate-session-w2yp1"]);
	});

	test("does nothing outside Herdr", () => {
		delete process.env.HERDR_ENV;
		const harness = makeHarness();
		expect(harness.handlers.size).toBe(0);
		expect(harness.calls).toEqual([]);
	});
});

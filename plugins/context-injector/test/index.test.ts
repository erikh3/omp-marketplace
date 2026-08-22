import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

// ---------------------------------------------------------------------------
// Minimal ExtensionAPI stub
// ---------------------------------------------------------------------------

type EventName = "session_start" | "before_agent_start";
type Handler = (event: unknown, ctx: unknown) => Promise<unknown>;

function makeApi() {
	const handlers = new Map<EventName, Handler[]>();

	const pi = {
		on: mock((event: EventName, handler: Handler) => {
			if (!handlers.has(event)) handlers.set(event, []);
			handlers.get(event)!.push(handler);
		}),
		logger: {
			debug: mock(() => {}),
			warn: mock(() => {}),
			info: mock(() => {}),
			error: mock(() => {}),
		},
	} as unknown as ExtensionAPI;

	async function fireSessionStart(cwd = "/project") {
		for (const h of handlers.get("session_start") ?? []) {
			await h({}, { cwd });
		}
	}

	async function fireBeforeAgentStart() {
		let result: unknown;
		for (const h of handlers.get("before_agent_start") ?? []) {
			result = await h({}, {});
		}
		return result as { message: { customType: string; content: string; display: boolean; attribution: string } } | undefined;
	}

	return { pi, fireSessionStart, fireBeforeAgentStart };
}

// ---------------------------------------------------------------------------
// Mock loadMergedConfig and buildSection so index.ts is fully isolated
// ---------------------------------------------------------------------------

import * as realConfig from "../src/config.ts";
import * as realInject from "../src/inject.ts";
import type { InjectionEntry } from "../src/types.ts";

let loadMergedConfigImpl: (cwd: string) => { inject: InjectionEntry[] } =
	() => ({ inject: [] });
const loadMergedConfig = mock((cwd: string) => loadMergedConfigImpl(cwd));

let buildSectionImpl: (entry: InjectionEntry, logger: unknown) => Promise<string | null> =
	async () => null;
const buildSection = mock((entry: InjectionEntry, logger: unknown) =>
	buildSectionImpl(entry, logger),
);

mock.module("../src/config.ts", () => ({ ...realConfig, loadMergedConfig }));
mock.module("../src/inject.ts", () => ({ ...realInject, buildSection }));

// Dynamic import after mock.module so index.ts binds to mocked deps
const { default: contextInjector } = await import("../src/index.ts");

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("contextInjector extension", () => {
	let api: ReturnType<typeof makeApi>;

	beforeEach(() => {
		api = makeApi();
		loadMergedConfig.mockClear();
		buildSection.mockClear();
		loadMergedConfigImpl = () => ({ inject: [] });
		buildSectionImpl = async () => null;
		contextInjector(api.pi);
	});

	test("registers session_start and before_agent_start handlers", () => {
		expect(api.pi.on).toHaveBeenCalledWith("session_start", expect.any(Function));
		expect(api.pi.on).toHaveBeenCalledWith("before_agent_start", expect.any(Function));
	});

	test("loads config on session_start", async () => {
		await api.fireSessionStart("/my-project");
		expect(loadMergedConfig).toHaveBeenCalledWith("/my-project");
	});

	test("swallows config load error and injects nothing", async () => {
		loadMergedConfigImpl = () => { throw new Error("bad config"); };
		await api.fireSessionStart();
		const result = await api.fireBeforeAgentStart();
		expect(result).toBeUndefined();
		expect(api.pi.logger.warn).toHaveBeenCalled();
	});

	test("returns undefined when inject list is empty", async () => {
		await api.fireSessionStart();
		const result = await api.fireBeforeAgentStart();
		expect(result).toBeUndefined();
	});

	test("injects content from a single entry", async () => {
		loadMergedConfigImpl = () => ({ inject: [{ path: "skill://my-skill" }] });
		buildSectionImpl = async () => "skill content";
		await api.fireSessionStart();
		const result = await api.fireBeforeAgentStart();
		expect(result?.message.content).toBe("skill content");
		expect(result?.message.customType).toBe("context-injector");
		expect(result?.message.attribution).toBe("agent");
	});

	test("joins multiple sections with separator", async () => {
		loadMergedConfigImpl = () => ({
			inject: [{ path: "skill://a" }, { path: "skill://b" }],
		});
		buildSectionImpl = async (entry) => `content for ${entry.path}`;
		await api.fireSessionStart();
		const result = await api.fireBeforeAgentStart();
		expect(result?.message.content).toBe("content for skill://a\n\n---\n\ncontent for skill://b");
	});

	test("once:true entry is skipped on second before_agent_start", async () => {
		loadMergedConfigImpl = () => ({ inject: [{ path: "skill://a", once: true }] });
		buildSectionImpl = async () => "content";
		await api.fireSessionStart();
		await api.fireBeforeAgentStart(); // first turn — injects
		const result = await api.fireBeforeAgentStart(); // second turn — skipped
		expect(result).toBeUndefined();
	});

	test("once:false entry re-injects on every turn", async () => {
		loadMergedConfigImpl = () => ({ inject: [{ path: "skill://a", once: false }] });
		buildSectionImpl = async () => "content";
		await api.fireSessionStart();
		const first = await api.fireBeforeAgentStart();
		const second = await api.fireBeforeAgentStart();
		expect(first?.message.content).toBe("content");
		expect(second?.message.content).toBe("content");
	});

	test("injectedIndices reset on session_start", async () => {
		loadMergedConfigImpl = () => ({ inject: [{ path: "skill://a", once: true }] });
		buildSectionImpl = async () => "content";
		await api.fireSessionStart();
		await api.fireBeforeAgentStart(); // injects, marks index 0
		await api.fireSessionStart();    // reset
		const result = await api.fireBeforeAgentStart(); // should inject again
		expect(result?.message.content).toBe("content");
	});

	test("display:false by default", async () => {
		loadMergedConfigImpl = () => ({ inject: [{ path: "skill://a" }] });
		buildSectionImpl = async () => "content";
		await api.fireSessionStart();
		const result = await api.fireBeforeAgentStart();
		expect(result?.message.display).toBe(false);
	});

	test("display:true on any entry makes message visible", async () => {
		loadMergedConfigImpl = () => ({
			inject: [
				{ path: "skill://a", display: false },
				{ path: "skill://b", display: true },
			],
		});
		buildSectionImpl = async () => "content";
		await api.fireSessionStart();
		const result = await api.fireBeforeAgentStart();
		expect(result?.message.display).toBe(true);
	});

	test("display:true entry with null content does not force display", async () => {
		loadMergedConfigImpl = () => ({
			inject: [
				{ path: "skill://missing", display: true },  // will return null
				{ path: "skill://a", display: false },
			],
		});
		let callCount = 0;
		buildSectionImpl = async () => callCount++ === 0 ? null : "content";
		await api.fireSessionStart();
		const result = await api.fireBeforeAgentStart();
		expect(result?.message.display).toBe(false);
	});

	test("skips entries where buildSection returns null", async () => {
		loadMergedConfigImpl = () => ({
			inject: [{ path: "skill://missing" }, { path: "skill://found" }],
		});
		let callCount = 0;
		buildSectionImpl = async () => callCount++ === 0 ? null : "found content";
		await api.fireSessionStart();
		const result = await api.fireBeforeAgentStart();
		expect(result?.message.content).toBe("found content");
	});
});

import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { ExtensionAPI, ExtensionContext, InputEventResult, SessionEntry } from "@oh-my-pi/pi-coding-agent";
import * as realTitleGenerator from "@oh-my-pi/pi-coding-agent/utils/title-generator";
import * as realPiAi from "@oh-my-pi/pi-ai";

// Controllable stub for the smol title model. Swapped per test via `titleImpl`.
// Mocked before importing the extension so the module binds to this stub.
let titleImpl: (firstMessage: string) => Promise<string | null> = async () => null;
const generateSessionTitle = mock(
	(firstMessage: string, ..._args: unknown[]): Promise<string | null> => titleImpl(firstMessage),
);
// Snapshot the real exports (captured before mock.module runs) and override
// only generateSessionTitle, so siblings the import graph relies on (e.g.
// setSessionTerminalTitle) stay intact.
const realExports = { ...realTitleGenerator };
mock.module("@oh-my-pi/pi-coding-agent/utils/title-generator", () => ({
	...realExports,
	generateSessionTitle,
}));
// Controllable stub for the summary model (completeSimple from pi-ai). The
// extension summarizes long transcripts before titling; this captures the
// transcript it is handed and returns a scripted assistant message. Only
// completeSimple is overridden so the rest of the pi-ai graph stays intact.
let lastSummaryInput: string | undefined;
let completeImpl: (transcript: string) => Promise<{
	stopReason: string;
	content: { type: string; text: string }[];
}> = async () => ({ stopReason: "stop", content: [{ type: "text", text: "" }] });
const completeSimple = mock(
	(
		_model: unknown,
		context: { systemPrompt?: unknown[]; messages: { content: string }[] },
		_options?: { maxTokens?: number; disableReasoning?: boolean; temperature?: number },
	) => {
		lastSummaryInput = context.messages[0]?.content ?? "";
		return completeImpl(lastSummaryInput);
	},
);
const realAiExports = { ...realPiAi };
mock.module("@oh-my-pi/pi-ai", () => ({
	...realAiExports,
	completeSimple,
}));
// Dynamic import: the extension must bind to the mocked title-generator above,
// so `mock.module` has to run before the module is loaded (static imports hoist).
const { default: sessionAutoname } = await import("../src/index.ts");

type InputHandler = (
	event: { text: string; type: "input"; source: "interactive" },
	ctx: ExtensionContext,
) => Promise<InputEventResult | void>;
type CommandHandler = (args: string, ctx: ExtensionContext) => Promise<void>;

let entrySeq = 0;

/** Minimal user/assistant transcript entry the extension reads. */
function messageEntry(role: "user" | "assistant", text: string): SessionEntry {
	// Test fixture: the extension reads only `type`, `message.role`, and
	// `message.content`. Cast at the fixture boundary rather than stub the full
	// SessionEntry union.
	return {
		type: "message",
		id: `e-${++entrySeq}`,
		parentId: null,
		message: { role, content: [{ type: "text", text }], timestamp: Date.now() },
	} as unknown as SessionEntry;
}

/** A message entry with an arbitrary role and raw content blocks, for
 *  exercising the role and content-block filters (tool calls, thinking,
 *  images, system/developer messages must be excluded). */
function richEntry(role: string, content: unknown): SessionEntry {
	return {
		type: "message",
		id: `e-${++entrySeq}`,
		parentId: null,
		message: { role, content, timestamp: Date.now() },
	} as unknown as SessionEntry;
}

/** A non-message entry (e.g. a model switch) that must be ignored. */
function noiseEntry(): SessionEntry {
	// Test fixture: shape the extension's filter must skip. Boundary cast.
	return { type: "model_change", id: `e-${++entrySeq}`, parentId: null, model: "x/y" } as unknown as SessionEntry;
}

interface Notice {
	message: string;
	type: string | undefined;
}
interface StatusCall {
	key: string;
	text: string | undefined;
}

/**
 * Build a captured harness around the extension. `entries` is the fake
 * transcript. Routing-only tests pass `[]` so the title model is never reached.
 */
function makeHarness(entries: SessionEntry[], options: { model?: unknown; branchEntries?: SessionEntry[] } = {}) {
	const names: string[] = [];
	const notices: Notice[] = [];
	const statuses: StatusCall[] = [];
	const warnings: unknown[][] = [];
	const commands = new Map<string, { description?: string; handler: CommandHandler }>();
	let inputHandler: InputHandler | undefined;

	const pi = {
		logger: {
			warn: (...args: unknown[]): void => {
				warnings.push(args);
			},
		},
		setSessionName: async (name: string): Promise<void> => {
			names.push(name);
		},
		registerCommand: (name: string, opts: { description?: string; handler: CommandHandler }): void => {
			commands.set(name, opts);
		},
		on: (event: string, handler: InputHandler): void => {
			if (event === "input") inputHandler = handler;
		},
		// pi.pi is the harness's injected module; the extension accesses pi.pi.settings
		// to avoid module-isolation bugs. generateSessionTitle is mocked so the stub
		// value is never read — it just needs to not throw on access.
		pi: { settings: {} },
		// Structural mock: the extension uses only the members above. Casting at
		// this test-only boundary avoids stubbing the entire ExtensionAPI surface.
	} as unknown as ExtensionAPI;

	const ctx = {
		modelRegistry: {
			// Only reached on the summary path (a model must be active); returns a
			// static key stand-in for the ApiKeyResolver completeSimple expects.
			resolver: (): string => "test-api-key",
		},
		model: options.model,
		sessionManager: {
			getBranch: (): SessionEntry[] => options.branchEntries ?? entries,
			getSessionId: (): string => "session-test",
		},
		ui: {
			notify: (message: string, type?: string): void => {
				notices.push({ message, type });
			},
			setStatus: (key: string, text: string | undefined): void => {
				statuses.push({ key, text });
			},
		},
	} as unknown as ExtensionContext;

	sessionAutoname(pi);
	if (!inputHandler) throw new Error("input handler was not registered");
	const input = inputHandler;

	return {
		ctx,
		names,
		notices,
		statuses,
		warnings,
		commands,
		runName: (args: string) => {
			const command = commands.get("name");
			if (!command) throw new Error("/name command not registered");
			return command.handler(args, ctx);
		},
		input: (text: string) => input({ text, type: "input", source: "interactive" }, ctx),
	};
}

beforeEach(() => {
	generateSessionTitle.mockClear();
	completeSimple.mockClear();
	titleImpl = async () => null;
	completeImpl = async () => ({ stopReason: "stop", content: [{ type: "text", text: "" }] });
	lastSummaryInput = undefined;
	entrySeq = 0;
});

describe("registration", () => {
	test("registers the /name command with a description", () => {
		const command = makeHarness([]).commands.get("name");
		expect(command).toBeDefined();
		expect(command?.description).toBeTruthy();
	});

	test("registers an input handler", () => {
		expect(() => makeHarness([])).not.toThrow();
	});
});

describe("input interception of bare /rename", () => {
	test("handles a bare /rename", async () => {
		expect((await makeHarness([]).input("/rename"))?.handled).toBe(true);
	});

	test("tolerates trailing whitespace", async () => {
		expect((await makeHarness([]).input("/rename   "))?.handled).toBe(true);
	});

	test("tolerates surrounding whitespace", async () => {
		expect((await makeHarness([]).input("   /rename  "))?.handled).toBe(true);
	});

	test("ignores uppercase /Rename (slash commands are lowercase)", async () => {
		expect(await makeHarness([]).input("/Rename")).toBeUndefined();
	});

	test("passes /rename <title> through to the built-in", async () => {
		expect(await makeHarness([]).input("/rename my title")).toBeUndefined();
	});

	test("does not match a /rename prefix like /renamed", async () => {
		expect(await makeHarness([]).input("/renamed")).toBeUndefined();
	});

	test("does not intercept /name (it dispatches to the registered command)", async () => {
		expect(await makeHarness([]).input("/name")).toBeUndefined();
	});

	test("ignores unrelated input", async () => {
		expect(await makeHarness([]).input("hello there")).toBeUndefined();
	});
});

describe("explicit naming via /name <title>", () => {
	test("sets the name verbatim", async () => {
		const h = makeHarness([]);
		await h.runName("Ship the widget");
		expect(h.names).toEqual(["Ship the widget"]);
	});

	test("trims surrounding whitespace", async () => {
		const h = makeHarness([]);
		await h.runName("   Ship the widget   ");
		expect(h.names).toEqual(["Ship the widget"]);
	});

	test("never invokes the title model", async () => {
		const h = makeHarness([messageEntry("user", "deploy the widget service")]);
		await h.runName("Manual Name");
		expect(generateSessionTitle).not.toHaveBeenCalled();
	});

	test("notifies with the applied name", async () => {
		const h = makeHarness([]);
		await h.runName("Manual Name");
		expect(h.notices.some(n => n.type === "info" && n.message.includes("Manual Name"))).toBe(true);
	});
});

describe("auto naming from session logs", () => {
	const transcript = (): SessionEntry[] => [
		messageEntry("user", "help me deploy the widget service"),
		messageEntry("assistant", "sure, updating the deployment manifest"),
	];

	test("bare /rename generates and applies a name", async () => {
		titleImpl = async () => "Deploy widget service manifest changes";
		const h = makeHarness(transcript());
		await h.input("/rename");
		expect(generateSessionTitle).toHaveBeenCalledTimes(1);
		expect(h.names).toEqual(["Deploy widget service manifest changes"]);
	});

	test("/name with no argument generates and applies a name", async () => {
		titleImpl = async () => "Deploy widget service manifest changes";
		const h = makeHarness(transcript());
		await h.runName("");
		expect(h.names).toEqual(["Deploy widget service manifest changes"]);
	});

	test("feeds a digest derived from the transcript to the model", async () => {
		titleImpl = async () => "Deploy widget service";
		const h = makeHarness(transcript());
		await h.runName("");
		const firstArg = generateSessionTitle.mock.calls[0]?.[0] ?? "";
		expect(firstArg).toContain("deploy the widget service");
	});

	test("requires concrete searchable titles", async () => {
		titleImpl = async () => "Upgrade session-autoname to omp 18.1.14";
		const h = makeHarness([messageEntry("user", "upgrade session-autoname dependencies to omp 18.1.14")]);
		await h.runName("");
		const customPrompt = generateSessionTitle.mock.calls[0]?.[6];
		expect(customPrompt).toContain("specific, searchable title");
		expect(customPrompt).toContain("Upgrade session-autoname to omp 18.1.14");
		expect(customPrompt).toContain("Version Upgrade");
		expect(h.names).toEqual(["Upgrade session-autoname to omp 18.1.14"]);
	});

	test("grounds a generic tiny-model title with transcript identifiers", async () => {
		titleImpl = async () => "Plugin Integration";
		const h = makeHarness([messageEntry("user", "link unslop-pr and inspect sap-cls 1.4.1")]);
		await h.runName("");
		expect(h.names).toEqual(["Plugin Integration unslop-pr sap-cls"]);
	});

	test("removes URLs and repository paths from generated titles", async () => {
		titleImpl = async () => "Smoke Test MCP Repository github.com/erikh3/omp-marketplace/pull/1";
		const h = makeHarness([
			messageEntry("user", "smoke test the MCP repository bypass on github.com/erikh3/omp-marketplace/pull/1"),
		]);
		await h.runName("");
		expect(h.names).toEqual(["Smoke Test MCP Repository omp-marketplace"]);
	});

	test("removes file paths while preserving plain identifiers", async () => {
		titleImpl = async () => "Fix subagent path @plugins/plugins-bin-to-path/ loading";
		const h = makeHarness([messageEntry("user", "fix @plugins/plugins-bin-to-path/ for subagents")]);
		await h.runName("");
		expect(h.names).toEqual(["Fix subagent path loading plugins-bin-to-path"]);
	});

	test("normalizes surrounding whitespace from a valid title", async () => {
		titleImpl = async () => "  Weird Yet Searchable Session Title  ";
		const h = makeHarness(transcript());
		await h.runName("");
		expect(h.names).toEqual(["Weird Yet Searchable Session Title"]);
	});

	test("shows a working status and clears it on success", async () => {
		titleImpl = async () => "Deploy widget service";
		const h = makeHarness(transcript());
		await h.runName("");
		expect(h.statuses.some(s => typeof s.text === "string")).toBe(true);
		expect(h.statuses.at(-1)?.text).toBeUndefined();
	});

	test("warns and does not rename when the model returns null", async () => {
		titleImpl = async () => null;
		const h = makeHarness(transcript());
		await h.runName("");
		expect(h.names).toHaveLength(0);
		expect(h.notices.some(n => n.type === "warning")).toBe(true);
	});

	test("warns and does not rename when the model returns an empty string", async () => {
		titleImpl = async () => "";
		const h = makeHarness(transcript());
		await h.runName("");
		expect(h.names).toHaveLength(0);
		expect(h.notices.some(n => n.type === "warning")).toBe(true);
	});

	test("surfaces an error and clears status when the model throws", async () => {
		titleImpl = async () => {
			throw new Error("model exploded");
		};
		const h = makeHarness(transcript());
		await h.runName("");
		expect(h.names).toHaveLength(0);
		expect(h.notices.some(n => n.type === "error")).toBe(true);
		expect(h.warnings).toHaveLength(1);
		expect(h.statuses.at(-1)?.text).toBeUndefined();
	});
});

describe("signal-less transcripts short-circuit the model", () => {
	test("no entries: warns without calling the model", async () => {
		const h = makeHarness([]);
		await h.runName("");
		expect(generateSessionTitle).not.toHaveBeenCalled();
		expect(h.notices.some(n => n.type === "warning")).toBe(true);
	});

	test("only non-message entries: warns without calling the model", async () => {
		const h = makeHarness([noiseEntry(), noiseEntry()]);
		await h.runName("");
		expect(generateSessionTitle).not.toHaveBeenCalled();
		expect(h.notices.some(n => n.type === "warning")).toBe(true);
	});
});

describe("whole-transcript coverage", () => {
	// More than the recent-turns window omp's title digest used to cap at, so an
	// early turn only survives if the WHOLE transcript is considered.
	const manyTurns = (): SessionEntry[] => {
		const entries: SessionEntry[] = [messageEntry("user", "calibrate the flux capacitor at dawn")];
		for (let i = 0; i < 12; i++) {
			entries.push(messageEntry("assistant", `step ${i} done`));
			entries.push(messageEntry("user", `next ${i}`));
		}
		return entries;
	};

	test("digest includes turns older than the recent window", async () => {
		titleImpl = async () => "Flux work";
		const h = makeHarness(manyTurns());
		await h.runName("");
		const firstArg = generateSessionTitle.mock.calls[0]?.[0] ?? "";
		expect(firstArg).toContain("calibrate the flux capacitor at dawn");
		expect(firstArg).toContain("next 11");
	});

	test("excludes messages outside the active branch", async () => {
		titleImpl = async () => "Active branch";
		const activeGoal = messageEntry("user", "fix the active checkout flow");
		const abandonedGoal = messageEntry("user", "replace the abandoned billing flow");
		const h = makeHarness([activeGoal, abandonedGoal], { branchEntries: [activeGoal] });
		await h.runName("");
		const firstArg = generateSessionTitle.mock.calls[0]?.[0] ?? "";
		expect(firstArg).toContain("active checkout flow");
		expect(firstArg).not.toContain("abandoned billing flow");
	});

	test("short transcript is titled directly, without a summary pass", async () => {
		titleImpl = async () => "Flux work";
		const h = makeHarness(manyTurns(), { model: { provider: "test", id: "big" } });
		await h.runName("");
		expect(completeSimple).not.toHaveBeenCalled();
	});

	test("keeps only user/assistant text; drops tool calls, thinking, and system messages", async () => {
		titleImpl = async () => "Filtered";
		const h = makeHarness([
			richEntry("system", [{ type: "text", text: "SYSTEM_PROMPT_MARKER" }]),
			richEntry("user", [
				{ type: "text", text: "user goal alpha" },
				{ type: "image", image: "…" },
			]),
			richEntry("assistant", [
				{ type: "thinking", thinking: "THINKING_MARKER" },
				{ type: "toolCall", id: "t1", name: "bash", arguments: {} },
				{ type: "text", text: "assistant reply beta" },
			]),
			richEntry("toolResult", [{ type: "text", text: "TOOL_RESULT_MARKER" }]),
		]);
		await h.runName("");
		const firstArg = generateSessionTitle.mock.calls[0]?.[0] ?? "";
		expect(firstArg).toContain("user goal alpha");
		expect(firstArg).toContain("assistant reply beta");
		expect(firstArg).not.toContain("SYSTEM_PROMPT_MARKER");
		expect(firstArg).not.toContain("THINKING_MARKER");
		expect(firstArg).not.toContain("TOOL_RESULT_MARKER");
	});
});

describe("direct title generation for long transcripts", () => {
	const longTranscript = (): SessionEntry[] => {
		const entries: SessionEntry[] = [
			messageEntry("user", "upgrade session-autoname dependencies from omp 17.4.2 to 18.1.14"),
		];
		for (let i = 0; i < 40; i++) {
			entries.push(messageEntry("assistant", `iteration ${i}: updated compatibility and reran plugin checks`));
			entries.push(messageEntry("user", `iteration ${i}: keep the session-autoname upgrade compatible with omp 18.1.14`));
		}
		return entries;
	};

	test("uses the active model title directly", async () => {
		completeImpl = async () => ({
			stopReason: "stop",
			content: [{ type: "text", text: "Upgrade session-autoname from omp 17.4.2 to 18.1.14" }],
		});
		const h = makeHarness(longTranscript(), { model: { provider: "test", id: "big" } });
		await h.runName("");
		expect(completeSimple).toHaveBeenCalledTimes(1);
		expect(lastSummaryInput ?? "").toContain("session-autoname dependencies from omp 17.4.2 to 18.1.14");
		expect(generateSessionTitle).not.toHaveBeenCalled();
		expect(h.names).toEqual(["Upgrade session-autoname from omp 17.4.2 to 18.1.14"]);
		const [, context, options] = completeSimple.mock.calls[0] ?? [];
		expect(context?.systemPrompt).toHaveLength(1);
		expect(context?.systemPrompt?.[0]).toContain("specific, searchable title");
		expect(options?.maxTokens).toBe(64);
		expect(options?.disableReasoning).toBe(true);
		expect(options?.temperature).toBe(0);
	});

	test("no active model titles the transcript with the tiny model", async () => {
		titleImpl = async () => "Fallback title";
		const h = makeHarness(longTranscript());
		await h.runName("");
		expect(completeSimple).not.toHaveBeenCalled();
		expect(generateSessionTitle.mock.calls[0]?.[0] ?? "").toContain("session-autoname dependencies");
	});

	test("active model error falls back to the tiny model", async () => {
		completeImpl = async () => ({ stopReason: "error", content: [] });
		titleImpl = async () => "Fallback searchable coding session title";
		const h = makeHarness(longTranscript(), { model: { provider: "test", id: "big" } });
		await h.runName("");
		expect(completeSimple).toHaveBeenCalledTimes(1);
		expect(generateSessionTitle.mock.calls[0]?.[0] ?? "").toContain("session-autoname dependencies");
		expect(h.names).toEqual(["Fallback searchable coding session title session-autoname"]);
	});

	test("grounds a generic active-model title after retry", async () => {
		completeImpl = async () => ({ stopReason: "stop", content: [{ type: "text", text: "Version Upgrade" }] });
		titleImpl = async () => "Fallback searchable coding session title";
		const h = makeHarness(longTranscript(), { model: { provider: "test", id: "big" } });
		await h.runName("");
		expect(h.names).toEqual(["Fallback searchable coding session title session-autoname"]);
	});
});

import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { ExtensionAPI, ExtensionContext, InputEventResult, SessionEntry } from "@oh-my-pi/pi-coding-agent";
import * as realTitleGenerator from "@oh-my-pi/pi-coding-agent/utils/title-generator";

// Controllable stub for the smol title model. Swapped per test via `titleImpl`.
// Mocked before importing the extension so the module binds to this stub.
let titleImpl: (firstMessage: string) => Promise<string | null> = async () => null;
const generateSessionTitle = mock((firstMessage: string): Promise<string | null> => titleImpl(firstMessage));
// Snapshot the real exports (captured before mock.module runs) and override
// only generateSessionTitle, so siblings the import graph relies on (e.g.
// setSessionTerminalTitle) stay intact.
const realExports = { ...realTitleGenerator };
mock.module("@oh-my-pi/pi-coding-agent/utils/title-generator", () => ({
	...realExports,
	generateSessionTitle,
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
function makeHarness(entries: SessionEntry[]) {
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
		// Structural mock: the extension uses only the members above. Casting at
		// this test-only boundary avoids stubbing the entire ExtensionAPI surface.
	} as unknown as ExtensionAPI;

	const ctx = {
		modelRegistry: {},
		model: undefined,
		sessionManager: { getEntries: (): SessionEntry[] => entries },
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
	titleImpl = async () => null;
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
		titleImpl = async () => "Deploy widget service";
		const h = makeHarness(transcript());
		await h.input("/rename");
		expect(generateSessionTitle).toHaveBeenCalledTimes(1);
		expect(h.names).toEqual(["Deploy widget service"]);
	});

	test("/name with no argument generates and applies a name", async () => {
		titleImpl = async () => "Deploy widget service";
		const h = makeHarness(transcript());
		await h.runName("");
		expect(h.names).toEqual(["Deploy widget service"]);
	});

	test("feeds a digest derived from the transcript to the model", async () => {
		titleImpl = async () => "Deploy widget service";
		const h = makeHarness(transcript());
		await h.runName("");
		const firstArg = generateSessionTitle.mock.calls[0]?.[0] ?? "";
		expect(firstArg).toContain("deploy the widget service");
	});

	test("applies the model's title without mutation", async () => {
		titleImpl = async () => "  Weird  Title  ";
		const h = makeHarness(transcript());
		await h.runName("");
		expect(h.names).toEqual(["  Weird  Title  "]);
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

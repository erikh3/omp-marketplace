/**
 * Tests for the git-commit-linter extension orchestrator (src/index.ts).
 *
 * Every external dependency is replaced with a handler-map mock. No git
 * subprocesses, no disk I/O, no commitlint evaluation.
 */

import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import type {
	ExtensionAPI,
	ExtensionContext,
	ToolCallEvent,
	ToolCallEventResult,
	ToolResultEvent,
	ToolResultEventResult,
} from "@oh-my-pi/pi-coding-agent";
import type {
	ShellAnalysis,
	ResolvedCommit,
	ConfigLoadResult,
	CommitLintResult,
	CommitInvocation,
	GitGlobalOptions,
	CommitOptions,
	EffectiveLintConfig,
} from "../src/types.ts";
import type { LintRuleOutcome } from "@commitlint/types";

// ---------------------------------------------------------------------------
// Shared invocation fixtures
// ---------------------------------------------------------------------------

const defaultGlobalOptions: GitGlobalOptions = {
	C: [],
	gitDir: undefined,
	workTree: undefined,
	namespace: undefined,
	execPath: undefined,
	noPager: false,
	leadingAssignments: new Map(),
};

const defaultCommitOptions: CommitOptions = {
	amend: false,
	noEdit: false,
	fixup: undefined,
	squash: undefined,
	allowEmptyMessage: false,
};

function makeInvocation(cwd: string = "/repo"): CommitInvocation {
	return {
		tokenStart: 0,
		tokenEnd: 10,
		effectiveCwd: cwd,
		gitGlobalOptions: defaultGlobalOptions,
		commitOptions: defaultCommitOptions,
		messageSource: { kind: "inline", paragraphs: ["feat: add thing"] },
		cleanupOverride: undefined,
		isGeneratedMessage: false,
	};
}

function makeError(name: string, message: string): LintRuleOutcome {
	return { level: 2, valid: false, name, message };
}

// ---------------------------------------------------------------------------
// Mock setup helpers
// ---------------------------------------------------------------------------

/**
 * Map of event-name → registered handler function, built up by pi.on().
 * Tests invoke these directly to simulate OMP lifecycle.
 */
type HandlerMap = {
	tool_call?: (event: ToolCallEvent, ctx: ExtensionContext) => Promise<ToolCallEventResult | void>;
	tool_result?: (event: ToolResultEvent, ctx: ExtensionContext) => ToolResultEventResult | void;
	session_shutdown?: (event: { type: "session_shutdown" }, ctx: ExtensionContext) => void;
};

/** Result from makeCtx — a fake ExtensionContext bundled with test introspection handles. */
interface CtxHarness {
	ctx: ExtensionContext;
	notifyCalls: Array<[string, string | undefined]>;
	clearTimerCalls: Timer[];
	pendingTimers: Map<Timer, { cb: () => void; fired: boolean }>;
	advanceTimers: () => void;
}

/** Flat harness returned by buildExtension: handlers + bare ExtensionContext + introspection. */
interface ExtensionHarness {
	handlers: HandlerMap;
	ctx: ExtensionContext;
	notifyCalls: Array<[string, string | undefined]>;
	clearTimerCalls: Timer[];
	pendingTimers: Map<Timer, { cb: () => void; fired: boolean }>;
	advanceTimers: () => void;
}

/** Create a fake ExtensionContext with controllable timers. */
function makeCtx(cwd: string = "/workspace"): CtxHarness {
	const notifyCalls: Array<[string, string | undefined]> = [];
	const clearTimerCalls: Timer[] = [];
	// Simple fake timer: stores callback, fires on advanceTimers()
	const pendingTimers = new Map<Timer, { cb: () => void; fired: boolean }>();
	let timerSeq = 1;

	const ctx = {
		cwd,
		ui: {
			notify: (msg: string, type?: "info" | "warning" | "error") => {
				notifyCalls.push([msg, type]);
			},
		},
		setTimeout: (cb: (...args: unknown[]) => void, _ms?: number): Timer => {
			const handle = timerSeq++ as unknown as Timer;
			pendingTimers.set(handle, { cb: cb as () => void, fired: false });
			return handle;
		},
		clearTimer: (timer: Timer) => {
			clearTimerCalls.push(timer);
			pendingTimers.delete(timer);
		},
		// Stub everything else we don't exercise in these tests.
		setInterval: () => 0 as unknown as Timer,
		mode: "tui" as const,
		model: undefined,
		models: {} as ExtensionContext["models"],
		hasUI: true,
		sessionManager: {} as ExtensionContext["sessionManager"],
		modelRegistry: {} as ExtensionContext["modelRegistry"],
		isIdle: () => true,
		abort: () => {},
		hasPendingMessages: () => false,
		shutdown: () => {},
		getSystemPrompt: () => [],
		getContextUsage: () => undefined,
		getAsyncJobSnapshot: () => null,
		compact: async () => {},
		isProjectTrusted: () => true,
	} as unknown as ExtensionContext;

	const advanceTimers = () => {
		for (const [handle, entry] of pendingTimers) {
			if (!entry.fired) {
				entry.fired = true;
				entry.cb();
				pendingTimers.delete(handle);
			}
		}
	};

	return { ctx, notifyCalls, clearTimerCalls, pendingTimers, advanceTimers };
}

// ---------------------------------------------------------------------------
// Mock modules
// ---------------------------------------------------------------------------

// We declare the mutable mock-control objects outside mock.module() so tests
// can change return values without re-evaluating modules.

let mockAnalyzeResult: ShellAnalysis = { kind: "no-commit" };
let mockResolveResult: ResolvedCommit = {
	resolution: "lint",
	invocation: makeInvocation(),
	repoRoot: "/repo",
	message: "feat: add thing",
};
let mockConfigResult: ConfigLoadResult = {
	kind: "ready",
	config: {
		commitlint: {} as unknown as EffectiveLintConfig["commitlint"],
		gitCommitLinter: {},
	},
};
let mockLintResult: CommitLintResult = {
	repoRoot: "/repo",
	invocation: makeInvocation(),
	message: "feat: add thing",
	valid: true,
	errors: [],
	warnings: [],
};

/**
 * Optional per-call override for resolveCommit. When set, called with the
 * invocation index (0-based) so tests can return different results per call.
 */
let mockResolveOverride: ((callIndex: number, inv: CommitInvocation) => ResolvedCommit) | undefined;
let mockResolveCallIndex = 0;

/**
 * Optional per-call override for lintCommit. Same pattern.
 */
let mockLintOverride: ((callIndex: number) => CommitLintResult) | undefined;
let mockLintCallIndex = 0;

mock.module("../src/commit-command.ts", () => ({
	analyzeCommand: (_cmd: string, _cwd: string) => mockAnalyzeResult,
}));
mock.module("../src/git-resolver.ts", () => ({
	resolveCommit: (inv: CommitInvocation) => {
		if (mockResolveOverride !== undefined) {
			return Promise.resolve(mockResolveOverride(mockResolveCallIndex++, inv));
		}
		return Promise.resolve(mockResolveResult);
	},
}));
mock.module("../src/config.ts", () => ({
	loadConfig: (_root: string) => Promise.resolve(mockConfigResult),
}));
mock.module("../src/lint.ts", () => ({
	lintCommit: (_msg: string, inv: CommitInvocation) => {
		if (mockLintOverride !== undefined) {
			return Promise.resolve(mockLintOverride(mockLintCallIndex++));
		}
		return Promise.resolve(mockLintResult);
	},
}));

// Also mock the OMP module so isToolCallEventType works correctly without
// the full runtime. We re-export a real implementation of the type guard.
mock.module("@oh-my-pi/pi-coding-agent", () => ({
	isToolCallEventType: (toolName: string, event: { toolName: string }) =>
		event.toolName === toolName,
}));

// Import the extension after mocks are in place.
const { default: gitCommitLinterExtension } = await import("../src/index.ts");

// ---------------------------------------------------------------------------
// Helper: build extension and extract handlers
// ---------------------------------------------------------------------------

function buildExtension(cwd: string = "/workspace"): ExtensionHarness {
	const handlers: HandlerMap = {};
	const harness = makeCtx(cwd);

	const loggerStub = {
		warn: () => {},
		error: () => {},
		info: () => {},
		debug: () => {},
	};

	const pi = {
		on: (event: string, handler: unknown) => {
			(handlers as Record<string, unknown>)[event] = handler;
		},
		logger: loggerStub,
	} as unknown as ExtensionAPI;

	gitCommitLinterExtension(pi);
	return {
		handlers,
		ctx: harness.ctx,
		notifyCalls: harness.notifyCalls,
		clearTimerCalls: harness.clearTimerCalls,
		pendingTimers: harness.pendingTimers,
		advanceTimers: harness.advanceTimers,
	};
}

/** Build a bash tool_call event. */
function makeToolCallEvent(
	toolCallId: string,
	command: string,
	cwd?: string,
): ToolCallEvent {
	return {
		type: "tool_call",
		toolCallId,
		toolName: "bash",
		input: { command, ...(cwd !== undefined ? { cwd } : {}) },
	} as unknown as ToolCallEvent;
}

/** Build a bash tool_result event. */
function makeToolResultEvent(
	toolCallId: string,
	text: string,
	isError = false,
): ToolResultEvent {
	return {
		type: "tool_result",
		toolCallId,
		toolName: "bash",
		input: {},
		content: [{ type: "text", text }],
		isError,
	} as unknown as ToolResultEvent;
}

/** Build a non-bash tool_call event. */
function makeReadToolCallEvent(toolCallId: string): ToolCallEvent {
	return {
		type: "tool_call",
		toolCallId,
		toolName: "read",
		input: { path: "/some/file" },
	} as unknown as ToolCallEvent;
}

/** Build a non-bash tool_result event. */
function makeReadToolResultEvent(toolCallId: string): ToolResultEvent {
	return {
		type: "tool_result",
		toolCallId,
		toolName: "read",
		input: {},
		content: [{ type: "text", text: "file content" }],
		isError: false,
	} as unknown as ToolResultEvent;
}

// ---------------------------------------------------------------------------
// Reset mocks between tests
// ---------------------------------------------------------------------------

beforeEach(() => {
	mockAnalyzeResult = { kind: "no-commit" };
	mockResolveResult = {
		resolution: "lint",
		invocation: makeInvocation(),
		repoRoot: "/repo",
		message: "feat: add thing",
	};
	mockConfigResult = {
		kind: "ready",
		config: {
			commitlint: {} as unknown as EffectiveLintConfig["commitlint"],
			gitCommitLinter: {},
		},
	};
	mockLintResult = {
		repoRoot: "/repo",
		invocation: makeInvocation(),
		message: "feat: add thing",
		valid: true,
		errors: [],
		warnings: [],
	};
	mockResolveOverride = undefined;
	mockResolveCallIndex = 0;
	mockLintOverride = undefined;
	mockLintCallIndex = 0;
});

afterEach(() => {});

// ---------------------------------------------------------------------------
// Non-Bash / no-commit pass-through
// ---------------------------------------------------------------------------

describe("non-Bash tool_call events", () => {
	it("passes through read events without modification", async () => {
		const { handlers, ctx } = buildExtension();
		const result = await handlers.tool_call!(
			makeReadToolCallEvent("id-1"),
			ctx,
		);
		expect(result).toBeUndefined();
	});

	it("passes through non-bash tool_result events without modification", () => {
		const { handlers, ctx } = buildExtension();
		const result = handlers.tool_result!(
			makeReadToolResultEvent("id-1"),
			ctx,
		);
		expect(result).toBeUndefined();
	});
});

describe("no-commit bash calls", () => {
	it("returns undefined when parser finds no git commit", async () => {
		mockAnalyzeResult = { kind: "no-commit" };
		const { handlers, ctx } = buildExtension();
		const result = await handlers.tool_call!(
			makeToolCallEvent("id-1", "echo hello"),
			ctx,
		);
		expect(result).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// Valid commit message — pass-through
// ---------------------------------------------------------------------------

describe("valid commit message", () => {
	it("returns undefined when lint passes", async () => {
		mockAnalyzeResult = {
			kind: "commits",
			invocations: [makeInvocation()],
		};
		mockResolveResult = {
			resolution: "lint",
			invocation: makeInvocation(),
			repoRoot: "/repo",
			message: "feat: add thing",
		};
		mockLintResult = {
			repoRoot: "/repo",
			invocation: makeInvocation(),
			message: "feat: add thing",
			valid: true,
			errors: [],
			warnings: [],
		};

		const { handlers, ctx } = buildExtension();
		const result = await handlers.tool_call!(
			makeToolCallEvent("id-1", "git commit -m 'feat: add thing'"),
			ctx,
		);
		expect(result).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// Invalid commit message — block
// ---------------------------------------------------------------------------

describe("invalid commit message", () => {
	it("blocks with formatted lint error reason", async () => {
		mockAnalyzeResult = {
			kind: "commits",
			invocations: [makeInvocation()],
		};
		mockResolveResult = {
			resolution: "lint",
			invocation: makeInvocation(),
			repoRoot: "/repo",
			message: "bad message no type",
		};
		mockLintResult = {
			repoRoot: "/repo",
			invocation: makeInvocation(),
			message: "bad message no type",
			valid: false,
			errors: [makeError("type-empty", "type may not be empty")],
			warnings: [],
		};

		const { handlers, ctx } = buildExtension();
		const result = await handlers.tool_call!(
			makeToolCallEvent("id-1", "git commit -m 'bad message no type'"),
			ctx,
		);

		expect(result?.block).toBe(true);
		expect(result?.reason).toContain("git commit blocked");
		expect(result?.reason).toContain("type-empty");
		expect(result?.reason).toContain("type may not be empty");
	});

	it("includes a bounded header preview in the block reason", async () => {
		mockAnalyzeResult = {
			kind: "commits",
			invocations: [makeInvocation()],
		};
		const longMessage = "x".repeat(100);
		mockResolveResult = {
			resolution: "lint",
			invocation: makeInvocation(),
			repoRoot: "/repo",
			message: longMessage,
		};
		mockLintResult = {
			repoRoot: "/repo",
			invocation: makeInvocation(),
			message: longMessage,
			valid: false,
			errors: [makeError("type-empty", "type may not be empty")],
			warnings: [],
		};

		const { handlers, ctx } = buildExtension();
		const result = await handlers.tool_call!(
			makeToolCallEvent("id-1", `git commit -m '${longMessage}'`),
			ctx,
		);

		expect(result?.block).toBe(true);
		// Header preview should be truncated to 72 code points max (71 + ellipsis).
		const reason = result?.reason ?? "";
		const headerLine = reason.split("\n").find((l) => l.startsWith("Header:"));
		expect(headerLine).toBeDefined();
		// The header value after "Header: " should be ≤72 code points.
		const headerValue = headerLine!.slice("Header: ".length);
		expect([...headerValue].length).toBeLessThanOrEqual(72);
	});
});

// ---------------------------------------------------------------------------
// Parser-level block
// ---------------------------------------------------------------------------

describe("parser-level block", () => {
	it("blocks when analyzeCommand returns blocked", async () => {
		mockAnalyzeResult = {
			kind: "blocked",
			reason: "expansion in git word",
		};

		const { handlers, ctx } = buildExtension();
		const result = await handlers.tool_call!(
			makeToolCallEvent("id-1", 'git commit -m "$(inject)"'),
			ctx,
		);

		expect(result?.block).toBe(true);
		expect(result?.reason).toContain("expansion in git word");
	});
});

// ---------------------------------------------------------------------------
// Resolver-level block
// ---------------------------------------------------------------------------

describe("resolver-level block", () => {
	it("blocks when resolveCommit returns blocked", async () => {
		mockAnalyzeResult = {
			kind: "commits",
			invocations: [makeInvocation()],
		};
		mockResolveResult = {
			resolution: "blocked",
			invocation: makeInvocation(),
			reason: "could not determine commit message",
		};

		const { handlers, ctx } = buildExtension();
		const result = await handlers.tool_call!(
			makeToolCallEvent("id-1", "git commit -F /tmp/msg"),
			ctx,
		);

		expect(result?.block).toBe(true);
		expect(result?.reason).toContain("could not determine commit message");
	});
});

// ---------------------------------------------------------------------------
// Fatal config block
// ---------------------------------------------------------------------------

describe("fatal config error", () => {
	it("blocks when loadConfig returns fatal", async () => {
		mockAnalyzeResult = {
			kind: "commits",
			invocations: [makeInvocation()],
		};
		mockResolveResult = {
			resolution: "lint",
			invocation: makeInvocation(),
			repoRoot: "/repo",
			message: "feat: add thing",
		};
		mockConfigResult = {
			kind: "fatal",
			error: new Error("JSONC parse error: unexpected token"),
		};

		const { handlers, ctx } = buildExtension();
		const result = await handlers.tool_call!(
			makeToolCallEvent("id-1", "git commit -m 'feat: add thing'"),
			ctx,
		);

		expect(result?.block).toBe(true);
		expect(result?.reason).toContain("Plugin config error");
		expect(result?.reason).toContain("JSONC parse error");
	});
});

// ---------------------------------------------------------------------------
// Broken repo config — allow + warning
// ---------------------------------------------------------------------------

describe("broken repository config", () => {
	it("allows Bash and stores pending warning", async () => {
		mockAnalyzeResult = {
			kind: "commits",
			invocations: [makeInvocation()],
		};
		mockResolveResult = {
			resolution: "lint",
			invocation: makeInvocation(),
			repoRoot: "/repo",
			message: "feat: add thing",
		};
		mockConfigResult = {
			kind: "broken-repository-config",
			error: new Error("commitlint config invalid"),
		};

		const { handlers, ctx, notifyCalls } = buildExtension();
		const toolCallResult = await handlers.tool_call!(
			makeToolCallEvent("call-1", "git commit -m 'feat: add thing'"),
			ctx,
		);

		// Bash must be allowed (no block).
		expect(toolCallResult?.block).toBeUndefined();

		// A notification should have been shown.
		expect(notifyCalls.length).toBe(1);
		expect(notifyCalls[0][1]).toBe("warning");
	});

	it("prepends warning to matching tool_result", async () => {
		mockAnalyzeResult = {
			kind: "commits",
			invocations: [makeInvocation()],
		};
		mockConfigResult = {
			kind: "broken-repository-config",
			error: new Error("broken config"),
		};

		const { handlers, ctx } = buildExtension();
		await handlers.tool_call!(
			makeToolCallEvent("call-2", "git commit -m 'feat: x'"),
			ctx,
		);

		const toolResultEvent = makeToolResultEvent("call-2", "Existing output");
		const resultOverride = handlers.tool_result!(toolResultEvent, ctx);

		expect(resultOverride?.content).toBeDefined();
		const contentArr = resultOverride!.content!;
		// First item is the prepended warning.
		expect(contentArr[0].type).toBe("text");
		const firstItem = contentArr[0];
		if (firstItem.type !== "text") throw new Error("Expected text type");
		expect(firstItem.text).toContain("Warning: commit linting was skipped");
		// Warning must end with a newline to separate from the original bash output.
		expect(firstItem.text).toMatch(/\n$/);
		// Second item is the original output.
		const secondItem = contentArr[1];
		if (secondItem.type !== "text") throw new Error("Expected text type");
		expect(secondItem.text).toBe("Existing output");
	});

	it("does not change isError on the tool_result", async () => {
		mockAnalyzeResult = {
			kind: "commits",
			invocations: [makeInvocation()],
		};
		mockConfigResult = {
			kind: "broken-repository-config",
			error: new Error("broken config"),
		};

		const { handlers, ctx } = buildExtension();
		await handlers.tool_call!(
			makeToolCallEvent("call-3", "git commit -m 'feat: x'"),
			ctx,
		);

		// Even with isError: true the override should not set isError.
		const toolResultEvent = makeToolResultEvent("call-3", "Bash error", true);
		const resultOverride = handlers.tool_result!(toolResultEvent, ctx);

		// isError override is absent — the existing value is preserved by the middleware.
		expect(resultOverride?.isError).toBeUndefined();
	});

	it("preserves original content for unrelated tool_result IDs", async () => {
		mockAnalyzeResult = {
			kind: "commits",
			invocations: [makeInvocation()],
		};
		mockConfigResult = {
			kind: "broken-repository-config",
			error: new Error("broken config"),
		};

		const { handlers, ctx } = buildExtension();
		await handlers.tool_call!(
			makeToolCallEvent("call-4", "git commit -m 'feat: x'"),
			ctx,
		);

		// tool_result for a different ID should be unchanged.
		const unrelated = makeToolResultEvent("other-id", "Other result");
		const result = handlers.tool_result!(unrelated, ctx);
		expect(result).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// Concurrent IDs — independent warnings
// ---------------------------------------------------------------------------

describe("concurrent tool call IDs", () => {
	it("stores independent warnings for concurrent calls", async () => {
		// Both calls trigger broken-repository-config.
		mockAnalyzeResult = {
			kind: "commits",
			invocations: [makeInvocation()],
		};
		mockConfigResult = {
			kind: "broken-repository-config",
			error: new Error("broken config"),
		};

		const { handlers, ctx } = buildExtension();

		// Two concurrent tool_calls — fire both before consuming either result.
		await handlers.tool_call!(
			makeToolCallEvent("concurrent-A", "git commit -m 'feat: a'"),
			ctx,
		);
		await handlers.tool_call!(
			makeToolCallEvent("concurrent-B", "git commit -m 'feat: b'"),
			ctx,
		);

		// Consume result for B first, then A.
		const resultB = handlers.tool_result!(
			makeToolResultEvent("concurrent-B", "Output B"),
			ctx,
		);
		const resultA = handlers.tool_result!(
			makeToolResultEvent("concurrent-A", "Output A"),
			ctx,
		);

		// Both should carry their own prepended warnings.
		expect(resultB?.content?.length).toBe(2);
		expect((resultB!.content![1] as { text: string }).text).toBe("Output B");

		expect(resultA?.content?.length).toBe(2);
		expect((resultA!.content![1] as { text: string }).text).toBe("Output A");
	});

	it("does not cross-contaminate: consuming one ID leaves the other intact", async () => {
		mockAnalyzeResult = {
			kind: "commits",
			invocations: [makeInvocation()],
		};
		mockConfigResult = {
			kind: "broken-repository-config",
			error: new Error("broken config"),
		};

		const { handlers, ctx } = buildExtension();

		await handlers.tool_call!(
			makeToolCallEvent("solo-A", "git commit -m 'feat: a'"),
			ctx,
		);
		await handlers.tool_call!(
			makeToolCallEvent("solo-B", "git commit -m 'feat: b'"),
			ctx,
		);

		// Consume A.
		handlers.tool_result!(makeToolResultEvent("solo-A", "A"), ctx);

		// B should still have its warning.
		const resultB = handlers.tool_result!(
			makeToolResultEvent("solo-B", "B"),
			ctx,
		);
		expect(resultB?.content?.length).toBe(2);
	});
});

// ---------------------------------------------------------------------------
// Middleware content preservation
// ---------------------------------------------------------------------------

describe("tool_result middleware content preservation", () => {
	it("preserves all original content items when prepending warning", async () => {
		mockAnalyzeResult = {
			kind: "commits",
			invocations: [makeInvocation()],
		};
		mockConfigResult = {
			kind: "broken-repository-config",
			error: new Error("broken config"),
		};

		const { handlers, ctx } = buildExtension();
		await handlers.tool_call!(
			makeToolCallEvent("multi-content", "git commit -m 'feat: x'"),
			ctx,
		);

		// Fabricate a tool_result with multiple content items.
		const multiResult: ToolResultEvent = {
			type: "tool_result",
			toolCallId: "multi-content",
			toolName: "bash",
			input: {},
			content: [
				{ type: "text", text: "line one" },
				{ type: "text", text: "line two" },
			],
			isError: false,
		} as unknown as ToolResultEvent;

		const override = handlers.tool_result!(multiResult, ctx);

		expect(override?.content?.length).toBe(3);
		expect((override!.content![1] as { text: string }).text).toBe("line one");
		expect((override!.content![2] as { text: string }).text).toBe("line two");
	});
});

// ---------------------------------------------------------------------------
// Error status preservation
// ---------------------------------------------------------------------------

describe("tool_result error status preservation", () => {
	it("does not return an isError override for a valid commit", async () => {
		mockAnalyzeResult = {
			kind: "commits",
			invocations: [makeInvocation()],
		};
		mockLintResult = {
			repoRoot: "/repo",
			invocation: makeInvocation(),
			message: "feat: ok",
			valid: true,
			errors: [],
			warnings: [],
		};

		const { handlers, ctx } = buildExtension();
		// No tool_call needed — just confirm tool_result for unknown ID is untouched.
		const result = handlers.tool_result!(
			makeToolResultEvent("no-warning", "Success", false),
			ctx,
		);
		expect(result).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// Skip / outside-repository resolutions — pass-through
// ---------------------------------------------------------------------------

describe("skip and outside-repository resolutions", () => {
	it("allows Bash when all resolutions are skip", async () => {
		mockAnalyzeResult = {
			kind: "commits",
			invocations: [makeInvocation()],
		};
		mockResolveResult = {
			resolution: "skip",
			invocation: makeInvocation(),
			repoRoot: "/repo",
		};

		const { handlers, ctx } = buildExtension();
		const result = await handlers.tool_call!(
			makeToolCallEvent("skip-1", "git commit --amend --no-edit"),
			ctx,
		);
		expect(result?.block).toBeUndefined();
	});

	it("allows Bash when all resolutions are outside-repository", async () => {
		mockAnalyzeResult = {
			kind: "commits",
			invocations: [makeInvocation()],
		};
		mockResolveResult = {
			resolution: "outside-repository",
			invocation: makeInvocation(),
		};

		const { handlers, ctx } = buildExtension();
		const result = await handlers.tool_call!(
			makeToolCallEvent("outside-1", "git commit -m 'x'"),
			ctx,
		);
		expect(result?.block).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// Compound command (multiple invocations)
// ---------------------------------------------------------------------------

describe("compound commands", () => {
	it("blocks if any commit in a compound command has lint errors", async () => {
		const inv1 = makeInvocation("/repo1");
		const inv2 = { ...makeInvocation("/repo2"), effectiveCwd: "/repo2" };

		mockAnalyzeResult = { kind: "commits", invocations: [inv1, inv2] };

		// resolveCommit: call 0 → lint/pass, call 1 → lint/fail.
		mockResolveOverride = (idx) =>
			idx === 0
				? { resolution: "lint", invocation: inv1, repoRoot: "/repo1", message: "feat: ok" }
				: { resolution: "lint", invocation: inv2, repoRoot: "/repo2", message: "bad message" };

		// lintCommit: call 0 → valid, call 1 → invalid.
		mockLintOverride = (idx) =>
			idx === 0
				? { repoRoot: "/repo1", invocation: inv1, message: "feat: ok", valid: true, errors: [], warnings: [] }
				: {
						repoRoot: "/repo2",
						invocation: inv2,
						message: "bad message",
						valid: false,
						errors: [makeError("type-empty", "type may not be empty")],
						warnings: [],
					};

		const { handlers, ctx } = buildExtension();
		const result = await handlers.tool_call!(
			makeToolCallEvent("compound-1", "git commit -m 'feat: ok' && git commit -m 'bad message'"),
			ctx,
		);

		expect(result?.block).toBe(true);
		expect(result?.reason).toContain("type-empty");
	});
});

// ---------------------------------------------------------------------------
// Expiry timer
// ---------------------------------------------------------------------------

describe("pending warning expiry", () => {
	it("drops warning after timer fires and returns undefined on tool_result", async () => {
		mockAnalyzeResult = {
			kind: "commits",
			invocations: [makeInvocation()],
		};
		mockConfigResult = {
			kind: "broken-repository-config",
			error: new Error("broken"),
		};

		const { handlers, ctx, advanceTimers } = buildExtension();
		await handlers.tool_call!(
			makeToolCallEvent("expiry-1", "git commit -m 'feat: x'"),
			ctx,
		);

		// Fire all pending timers (simulates TTL expiry).
		advanceTimers();

		// tool_result arrives after expiry — warning should be gone.
		const result = handlers.tool_result!(
			makeToolResultEvent("expiry-1", "Output"),
			ctx,
		);
		expect(result).toBeUndefined();
	});

	it("cancels timer when warning is consumed by tool_result", async () => {
		mockAnalyzeResult = {
			kind: "commits",
			invocations: [makeInvocation()],
		};
		mockConfigResult = {
			kind: "broken-repository-config",
			error: new Error("broken"),
		};

		const { handlers, ctx, clearTimerCalls } = buildExtension();
		await handlers.tool_call!(
			makeToolCallEvent("timer-cancel-1", "git commit -m 'feat: x'"),
			ctx,
		);

		// Consume the warning — should cancel the timer.
		handlers.tool_result!(
			makeToolResultEvent("timer-cancel-1", "Output"),
			ctx,
		);

		// clearTimer should have been called once.
		expect(clearTimerCalls.length).toBe(1);
	});
});

// ---------------------------------------------------------------------------
// session_shutdown
// ---------------------------------------------------------------------------

describe("session_shutdown", () => {
	it("clears all pending timers and drains the map", async () => {
		mockAnalyzeResult = {
			kind: "commits",
			invocations: [makeInvocation()],
		};
		mockConfigResult = {
			kind: "broken-repository-config",
			error: new Error("broken"),
		};

		const { handlers, ctx, clearTimerCalls } = buildExtension();

		// Add multiple pending warnings.
		await handlers.tool_call!(
			makeToolCallEvent("sd-1", "git commit -m 'feat: a'"),
			ctx,
		);
		await handlers.tool_call!(
			makeToolCallEvent("sd-2", "git commit -m 'feat: b'"),
			ctx,
		);

		// Fire shutdown.
		handlers.session_shutdown!({ type: "session_shutdown" }, ctx);

		// Both timers should have been cleared.
		expect(clearTimerCalls.length).toBe(2);

		// After shutdown, tool_result for either ID should return nothing.
		const r1 = handlers.tool_result!(makeToolResultEvent("sd-1", "x"), ctx);
		const r2 = handlers.tool_result!(makeToolResultEvent("sd-2", "y"), ctx);
		expect(r1).toBeUndefined();
		expect(r2).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// Async warning delivery — no user_bash
// ---------------------------------------------------------------------------

describe("async warning behavior", () => {
	it("stores warning synchronously during tool_call; delivers on tool_result", async () => {
		// Verify that the warning is available between the async tool_call and the
		// (later) tool_result without any additional round-trips.
		mockAnalyzeResult = {
			kind: "commits",
			invocations: [makeInvocation()],
		};
		mockConfigResult = {
			kind: "broken-repository-config",
			error: new Error("broken"),
		};

		const { handlers, ctx } = buildExtension();

		// Await the tool_call (async, but warning stored before it returns).
		await handlers.tool_call!(
			makeToolCallEvent("async-w-1", "git commit -m 'feat: x'"),
			ctx,
		);

		// Deliver result — warning should already be present.
		const override = handlers.tool_result!(
			makeToolResultEvent("async-w-1", "Done"),
			ctx,
		);
		expect(override?.content).toBeDefined();
		expect(override!.content!.length).toBe(2);
	});
});

// ---------------------------------------------------------------------------
// No user_bash registration
// ---------------------------------------------------------------------------

describe("no user_bash registration", () => {
	it("never registers a user_bash handler", () => {
		const { handlers } = buildExtension();
		// The handlers map should not contain a user_bash key.
		expect((handlers as Record<string, unknown>)["user_bash"]).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// cwd resolution
// ---------------------------------------------------------------------------

describe("effective cwd resolution", () => {
	it("uses ctx.cwd when event has no cwd", async () => {
		let capturedCwd: string | undefined;
		mock.module("../src/commit-command.ts", () => ({
			analyzeCommand: (_cmd: string, cwd: string) => {
				capturedCwd = cwd;
				return { kind: "no-commit" } satisfies ShellAnalysis;
			},
		}));

		const { handlers, ctx } = buildExtension("/workspace-cwd");
		await handlers.tool_call!(makeToolCallEvent("cwd-1", "echo hello"), ctx);

		expect(capturedCwd).toBe("/workspace-cwd");

		// Restore mock.
		mock.module("../src/commit-command.ts", () => ({
			analyzeCommand: (_cmd: string, _cwd: string) => mockAnalyzeResult,
		}));
	});

	it("resolves event.input.cwd against ctx.cwd when present", async () => {
		let capturedCwd: string | undefined;
		mock.module("../src/commit-command.ts", () => ({
			analyzeCommand: (_cmd: string, cwd: string) => {
				capturedCwd = cwd;
				return { kind: "no-commit" } satisfies ShellAnalysis;
			},
		}));

		const { handlers, ctx } = buildExtension("/workspace");
		// Absolute cwd in event — should be passed as-is (resolve("/workspace", "/absolute/path") = "/absolute/path").
		await handlers.tool_call!(makeToolCallEvent("cwd-2", "echo hello", "/absolute/path"), ctx);

		expect(capturedCwd).toBe("/absolute/path");

		// Restore mock.
		mock.module("../src/commit-command.ts", () => ({
			analyzeCommand: (_cmd: string, _cwd: string) => mockAnalyzeResult,
		}));
	});
});

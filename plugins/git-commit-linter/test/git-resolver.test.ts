import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtemp, rm, mkdir, writeFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveCommit } from "../src/git-resolver.ts";
import type { CommitInvocation, MessageSource, GitGlobalOptions, CommitOptions } from "../src/types.ts";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Run a git command in `cwd` and throw on non-zero exit. */
async function git(args: string[], cwd: string): Promise<string> {
	const proc = Bun.spawn(["git", ...args], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
		stdin: "inherit",
		env: {
			...process.env,
			// Ensure consistent git identity in tests
			GIT_AUTHOR_NAME: "Test",
			GIT_AUTHOR_EMAIL: "test@example.com",
			GIT_COMMITTER_NAME: "Test",
			GIT_COMMITTER_EMAIL: "test@example.com",
		},
	});
	const [out, err, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	if (code !== 0) throw new Error(`git ${args.join(" ")} failed (${code}): ${err}`);
	return out.trim();
}

/** Initialize a bare-minimum git repo at `dir`. */
async function initRepo(dir: string): Promise<void> {
	await git(["init"], dir);
	await git(["config", "user.email", "test@example.com"], dir);
	await git(["config", "user.name", "Test"], dir);
}

/** Create an initial commit and return its hash. */
async function makeCommit(dir: string, msg: string, file = "file.txt"): Promise<string> {
	await writeFile(join(dir, file), `content-${Date.now()}`);
	await git(["add", file], dir);
	await git(["commit", "--allow-empty-message", "-m", msg], dir);
	return git(["rev-parse", "HEAD"], dir);
}

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

function makeInvocation(
	source: MessageSource,
	effectiveCwd: string,
	overrides?: Partial<CommitInvocation>,
): CommitInvocation {
	return {
		tokenStart: 0,
		tokenEnd: 10,
		effectiveCwd,
		gitGlobalOptions: defaultGlobalOptions,
		commitOptions: defaultCommitOptions,
		messageSource: source,
		cleanupOverride: undefined,
		isGeneratedMessage: false,
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// Temp directory lifecycle
// ---------------------------------------------------------------------------

let tmpBase: string;

beforeAll(async () => {
	// Resolve symlinks so our paths match what git rev-parse --show-toplevel returns.
	const raw = await mkdtemp(join(tmpdir(), "gcl-test-"));
	tmpBase = await realpath(raw);
});

afterAll(async () => {
	await rm(tmpBase, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Outside-repository pass-through
// ---------------------------------------------------------------------------

describe("resolveCommit — outside repository", () => {
	it("returns outside-repository when cwd is not inside a git repo", async () => {
		const outside = join(tmpBase, "not-a-repo");
		await mkdir(outside, { recursive: true });

		const invocation = makeInvocation(
			{ kind: "inline", paragraphs: ["feat: something"] },
			outside,
		);
		const result = await resolveCommit(invocation);
		expect(result.resolution).toBe("outside-repository");
	});
});

// ---------------------------------------------------------------------------
// Generated / amend-no-edit skips
// ---------------------------------------------------------------------------

describe("resolveCommit — generated / amend-no-edit skips", () => {
	let repoDir: string;

	beforeAll(async () => {
		repoDir = join(tmpBase, "skip-repo");
		await mkdir(repoDir);
		await initRepo(repoDir);
		await makeCommit(repoDir, "chore: initial");
	});

	it("skips when isGeneratedMessage is true", async () => {
		const invocation = makeInvocation(
			{ kind: "inline", paragraphs: ["some message"] },
			repoDir,
			{ isGeneratedMessage: true },
		);
		const result = await resolveCommit(invocation);
		expect(result.resolution).toBe("skip");
	});

	it("skips for amend-no-edit source", async () => {
		const invocation = makeInvocation({ kind: "amend-no-edit" }, repoDir);
		const result = await resolveCommit(invocation);
		expect(result.resolution).toBe("skip");
	});

	it("skips for generated source", async () => {
		const invocation = makeInvocation({ kind: "generated" }, repoDir);
		const result = await resolveCommit(invocation);
		expect(result.resolution).toBe("skip");
	});
});

// ---------------------------------------------------------------------------
// Generated / amend-no-edit — unexpected worktree failure blocks
// ---------------------------------------------------------------------------

describe("resolveCommit — generated/amend-no-edit worktree failure blocks", () => {
	let repoDir: string;

	beforeAll(async () => {
		repoDir = join(tmpBase, "skip-fail-repo");
		await mkdir(repoDir);
		await initRepo(repoDir);
		await makeCommit(repoDir, "chore: initial");
	});

	/**
	 * Replace Bun.spawn for the duration of `fn` with a stub that returns a
	 * non-128, non-zero exit code, simulating an unexpected Git failure (e.g.
	 * a transient internal error or a permissions problem that isn't "not a
	 * repository").
	 */
	async function withFailingGit<T>(fn: () => Promise<T>): Promise<T> {
		const original = Bun.spawn.bind(Bun);
		// @ts-ignore — intentional monkey-patch for test isolation
		Bun.spawn = () => {
			const mockStdout: ReadableStream<Uint8Array> = new ReadableStream<Uint8Array>({
				start(ctrl) {
					ctrl.close();
				},
			});
			const mockStderr: ReadableStream<Uint8Array> = new ReadableStream<Uint8Array>({
				start(ctrl) {
					ctrl.enqueue(new TextEncoder().encode("simulated git internal error"));
					ctrl.close();
				},
			});
			return {
				stdout: mockStdout,
				stderr: mockStderr,
				exited: Promise.resolve(1),
				kill() {},
			};
		};
		try {
			return await fn();
		} finally {
			// @ts-ignore
			Bun.spawn = original;
		}
	}

	it("blocks when worktree resolution fails for isGeneratedMessage", async () => {
		const invocation = makeInvocation(
			{ kind: "inline", paragraphs: ["fixup! some message"] },
			repoDir,
			{ isGeneratedMessage: true },
		);
		const result = await withFailingGit(() => resolveCommit(invocation));
		expect(result.resolution).toBe("blocked");
	});

	it("blocks when worktree resolution fails for amend-no-edit source", async () => {
		const invocation = makeInvocation({ kind: "amend-no-edit" }, repoDir);
		const result = await withFailingGit(() => resolveCommit(invocation));
		expect(result.resolution).toBe("blocked");
	});

	it("blocks when worktree resolution fails for generated source", async () => {
		const invocation = makeInvocation({ kind: "generated" }, repoDir);
		const result = await withFailingGit(() => resolveCommit(invocation));
		expect(result.resolution).toBe("blocked");
	});
});


// ---------------------------------------------------------------------------
// Editor-bound blocks
// ---------------------------------------------------------------------------

describe("resolveCommit — editor-bound", () => {
	let repoDir: string;

	beforeAll(async () => {
		repoDir = join(tmpBase, "editor-repo");
		await mkdir(repoDir);
		await initRepo(repoDir);
		await makeCommit(repoDir, "chore: initial");
	});

	it("blocks editor-bound commits", async () => {
		const invocation = makeInvocation({ kind: "editor-bound" }, repoDir);
		const result = await resolveCommit(invocation);
		expect(result.resolution).toBe("blocked");
		if (result.resolution === "blocked") {
			expect(result.reason).toContain("editor-bound");
		}
	});
});

// ---------------------------------------------------------------------------
// Inline -m
// ---------------------------------------------------------------------------

describe("resolveCommit — inline -m", () => {
	let repoDir: string;

	beforeAll(async () => {
		repoDir = join(tmpBase, "inline-repo");
		await mkdir(repoDir);
		await initRepo(repoDir);
		await makeCommit(repoDir, "chore: initial");
	});

	it("resolves a simple inline message", async () => {
		const invocation = makeInvocation(
			{ kind: "inline", paragraphs: ["feat: add feature"] },
			repoDir,
		);
		const result = await resolveCommit(invocation);
		expect(result.resolution).toBe("lint");
		if (result.resolution === "lint") {
			expect(result.message).toBe("feat: add feature");
			expect(result.repoRoot).toBeTruthy();
		}
	});

	it("joins multiple paragraphs with double newline", async () => {
		const invocation = makeInvocation(
			{ kind: "inline", paragraphs: ["feat: add", "extends scope"] },
			repoDir,
		);
		const result = await resolveCommit(invocation);
		expect(result.resolution).toBe("lint");
		if (result.resolution === "lint") {
			expect(result.message).toBe("feat: add\n\nextends scope");
		}
	});

	it("applies whitespace cleanup for non-editor inline source (default mode)", async () => {
		const invocation = makeInvocation(
			{ kind: "inline", paragraphs: ["feat: x  ", "", "body  "] },
			repoDir,
		);
		const result = await resolveCommit(invocation);
		expect(result.resolution).toBe("lint");
		if (result.resolution === "lint") {
			// default for non-editor = whitespace; trailing spaces stripped,
			// blank lines preserved (not stripped because whitespace keeps comments)
			expect(result.message).toContain("feat: x");
			expect(result.message).not.toContain("  "); // no trailing spaces
		}
	});

	it("resolves repo root to the git root directory", async () => {
		// Create a subdirectory to run from
		const sub = join(repoDir, "subdir");
		await mkdir(sub, { recursive: true });
		const invocation = makeInvocation(
			{ kind: "inline", paragraphs: ["feat: from subdir"] },
			sub,
		);
		const result = await resolveCommit(invocation);
		expect(result.resolution).toBe("lint");
		if (result.resolution === "lint") {
			expect(result.repoRoot).toBe(repoDir);
		}
	});
});

// ---------------------------------------------------------------------------
// File source -F
// ---------------------------------------------------------------------------

describe("resolveCommit — file -F", () => {
	let repoDir: string;

	beforeAll(async () => {
		repoDir = join(tmpBase, "file-repo");
		await mkdir(repoDir);
		await initRepo(repoDir);
		await makeCommit(repoDir, "chore: initial");
	});

	it("resolves an existing message file", async () => {
		const msgFile = join(repoDir, "msg.txt");
		await writeFile(msgFile, "feat: from file\n\nbody paragraph\n");
		const invocation = makeInvocation(
			{ kind: "file", path: "msg.txt" },
			repoDir,
		);
		const result = await resolveCommit(invocation);
		expect(result.resolution).toBe("lint");
		if (result.resolution === "lint") {
			// whitespace cleanup: trailing newline trimmed
			expect(result.message).toBe("feat: from file\n\nbody paragraph");
		}
	});

	it("blocks when file does not exist", async () => {
		const invocation = makeInvocation(
			{ kind: "file", path: "nonexistent.txt" },
			repoDir,
		);
		const result = await resolveCommit(invocation);
		expect(result.resolution).toBe("blocked");
		if (result.resolution === "blocked") {
			expect(result.reason).toContain("nonexistent.txt");
		}
	});

	it("resolves absolute path to file", async () => {
		const msgFile = join(repoDir, "abs-msg.txt");
		await writeFile(msgFile, "fix: absolute path\n");
		const invocation = makeInvocation(
			{ kind: "file", path: msgFile },
			repoDir,
		);
		const result = await resolveCommit(invocation);
		expect(result.resolution).toBe("lint");
		if (result.resolution === "lint") {
			expect(result.message).toBe("fix: absolute path");
		}
	});
});

// ---------------------------------------------------------------------------
// Reuse-commit -C
// ---------------------------------------------------------------------------

describe("resolveCommit — reuse-commit -C", () => {
	let repoDir: string;
	let commitHash: string;

	beforeAll(async () => {
		repoDir = join(tmpBase, "reuse-repo");
		await mkdir(repoDir);
		await initRepo(repoDir);
		commitHash = await makeCommit(repoDir, "feat: original commit\n\nbody text");
	});

	it("resolves the selected commit message", async () => {
		const invocation = makeInvocation(
			{ kind: "reuse-commit", revision: commitHash },
			repoDir,
		);
		const result = await resolveCommit(invocation);
		expect(result.resolution).toBe("lint");
		if (result.resolution === "lint") {
			expect(result.message).toContain("feat: original commit");
		}
	});

	it("blocks when revision does not exist", async () => {
		const invocation = makeInvocation(
			{ kind: "reuse-commit", revision: "deadbeef00000000000000000000000000000000" },
			repoDir,
		);
		const result = await resolveCommit(invocation);
		expect(result.resolution).toBe("blocked");
		if (result.resolution === "blocked") {
			expect(result.reason).toContain("deadbeef");
		}
	});

	it("resolves HEAD as a revision shorthand", async () => {
		const invocation = makeInvocation(
			{ kind: "reuse-commit", revision: "HEAD" },
			repoDir,
		);
		const result = await resolveCommit(invocation);
		expect(result.resolution).toBe("lint");
		if (result.resolution === "lint") {
			expect(result.message).toContain("feat: original commit");
		}
	});
});

// ---------------------------------------------------------------------------
// Reedit-commit -c (noninteractive GIT_EDITOR=true path)
// ---------------------------------------------------------------------------

describe("resolveCommit — reedit-commit -c", () => {
	let repoDir: string;
	let commitHash: string;

	beforeAll(async () => {
		repoDir = join(tmpBase, "reedit-repo");
		await mkdir(repoDir);
		await initRepo(repoDir);
		commitHash = await makeCommit(repoDir, "feat: source commit\n\nbody");
	});

	it("resolves the source commit and uses strip (editor-path default)", async () => {
		const invocation = makeInvocation(
			{ kind: "reedit-commit", revision: commitHash },
			repoDir,
		);
		const result = await resolveCommit(invocation);
		expect(result.resolution).toBe("lint");
		if (result.resolution === "lint") {
			// default for editor source = strip; comment lines removed
			expect(result.message).toContain("feat: source commit");
		}
	});

	it("blocks for nonexistent revision", async () => {
		const invocation = makeInvocation(
			{ kind: "reedit-commit", revision: "bad-revision-xyz" },
			repoDir,
		);
		const result = await resolveCommit(invocation);
		expect(result.resolution).toBe("blocked");
	});
});

// ---------------------------------------------------------------------------
// Cleanup override
// ---------------------------------------------------------------------------

describe("resolveCommit — cleanup override", () => {
	let repoDir: string;

	beforeAll(async () => {
		repoDir = join(tmpBase, "cleanup-repo");
		await mkdir(repoDir);
		await initRepo(repoDir);
		await makeCommit(repoDir, "chore: initial");
	});

	it("verbatim preserves trailing whitespace and comment lines", async () => {
		const invocation = makeInvocation(
			{ kind: "inline", paragraphs: ["feat: x  ", "# comment"] },
			repoDir,
			{ cleanupOverride: "verbatim" },
		);
		const result = await resolveCommit(invocation);
		expect(result.resolution).toBe("lint");
		if (result.resolution === "lint") {
			// paragraphs joined with \n\n, no cleanup
			expect(result.message).toBe("feat: x  \n\n# comment");
		}
	});

	it("strip removes comment lines", async () => {
		const invocation = makeInvocation(
			{ kind: "inline", paragraphs: ["feat: x", "# a comment"] },
			repoDir,
			{ cleanupOverride: "strip" },
		);
		const result = await resolveCommit(invocation);
		expect(result.resolution).toBe("lint");
		if (result.resolution === "lint") {
			expect(result.message).toBe("feat: x");
		}
	});

	it("whitespace keeps comment lines", async () => {
		const invocation = makeInvocation(
			{ kind: "inline", paragraphs: ["feat: x", "# a comment"] },
			repoDir,
			{ cleanupOverride: "whitespace" },
		);
		const result = await resolveCommit(invocation);
		expect(result.resolution).toBe("lint");
		if (result.resolution === "lint") {
			expect(result.message).toBe("feat: x\n\n# a comment");
		}
	});
});

// ---------------------------------------------------------------------------
// Repository commit.cleanup config
// ---------------------------------------------------------------------------

describe("resolveCommit — repo commit.cleanup config", () => {
	let repoDir: string;

	beforeAll(async () => {
		repoDir = join(tmpBase, "repo-cleanup-config");
		await mkdir(repoDir);
		await initRepo(repoDir);
		await makeCommit(repoDir, "chore: initial");
		// Set repo-level cleanup to strip
		await git(["config", "commit.cleanup", "strip"], repoDir);
	});

	it("uses repository commit.cleanup when no override given", async () => {
		const invocation = makeInvocation(
			{ kind: "inline", paragraphs: ["feat: subject", "# comment line"] },
			repoDir,
		);
		const result = await resolveCommit(invocation);
		expect(result.resolution).toBe("lint");
		if (result.resolution === "lint") {
			// strip removes comment lines
			expect(result.message).toBe("feat: subject");
		}
	});

	it("command-line --cleanup overrides repo config", async () => {
		const invocation = makeInvocation(
			{ kind: "inline", paragraphs: ["feat: subject", "# comment line"] },
			repoDir,
			{ cleanupOverride: "whitespace" },
		);
		const result = await resolveCommit(invocation);
		expect(result.resolution).toBe("lint");
		if (result.resolution === "lint") {
			// whitespace: comment line preserved
			expect(result.message).toContain("# comment line");
		}
	});
});

// ---------------------------------------------------------------------------
// core.commentChar=auto blocks when strip/scissors needed
// ---------------------------------------------------------------------------

describe("resolveCommit — core.commentChar=auto", () => {
	let repoDir: string;

	beforeAll(async () => {
		repoDir = join(tmpBase, "auto-commentchar-repo");
		await mkdir(repoDir);
		await initRepo(repoDir);
		await makeCommit(repoDir, "chore: initial");
		await git(["config", "core.commentChar", "auto"], repoDir);
	});

	it("blocks when effective mode is strip (default for editor source)", async () => {
		const invocation = makeInvocation(
			// reedit-commit uses editor path → default = strip
			{ kind: "reedit-commit", revision: "HEAD" },
			repoDir,
		);
		const result = await resolveCommit(invocation);
		expect(result.resolution).toBe("blocked");
		if (result.resolution === "blocked") {
			expect(result.reason).toContain("auto");
		}
	});

	it("proceeds when effective mode is whitespace (default for non-editor)", async () => {
		const invocation = makeInvocation(
			{ kind: "inline", paragraphs: ["feat: fine"] },
			repoDir,
		);
		// default + non-editor = whitespace; commentChar=auto is OK
		const result = await resolveCommit(invocation);
		expect(result.resolution).toBe("lint");
	});

	it("blocks when explicit cleanup is scissors", async () => {
		const invocation = makeInvocation(
			{ kind: "inline", paragraphs: ["feat: x"] },
			repoDir,
			{ cleanupOverride: "scissors" },
		);
		// scissors on non-editor source still applies whitespace, not truncation —
		// BUT scissors mode itself still needs commentChar for the line match.
		// Per the plan: scissors + auto → block.
		const result = await resolveCommit(invocation);
		expect(result.resolution).toBe("blocked");
	});
});

// ---------------------------------------------------------------------------
// -C with git -C (global option)
// ---------------------------------------------------------------------------

describe("resolveCommit — git -C global option", () => {
	let repoDir: string;
	let commitHash: string;

	beforeAll(async () => {
		repoDir = join(tmpBase, "global-C-repo");
		await mkdir(repoDir);
		await initRepo(repoDir);
		commitHash = await makeCommit(repoDir, "feat: hello from -C");
	});

	it("resolves repo root when git -C points into the repo", async () => {
		const sub = join(repoDir, "sub");
		await mkdir(sub, { recursive: true });

		// effectiveCwd is the temp root, but -C points to the actual repo
		const invocation: CommitInvocation = {
			tokenStart: 0,
			tokenEnd: 10,
			effectiveCwd: tmpBase,
			gitGlobalOptions: {
				...defaultGlobalOptions,
				C: [repoDir],
			},
			commitOptions: defaultCommitOptions,
			messageSource: { kind: "inline", paragraphs: ["feat: via -C"] },
			cleanupOverride: undefined,
			isGeneratedMessage: false,
		};
		const result = await resolveCommit(invocation);
		expect(result.resolution).toBe("lint");
		if (result.resolution === "lint") {
			expect(result.repoRoot).toBe(repoDir);
		}
	});
});

// ---------------------------------------------------------------------------
// runGit timeout resolves to blocked (never throws)
// ---------------------------------------------------------------------------

describe("resolveCommit — git subprocess timeout returns blocked", () => {
	let repoDir: string;

	beforeAll(async () => {
		repoDir = join(tmpBase, "timeout-repo");
		await mkdir(repoDir);
		await initRepo(repoDir);
		await makeCommit(repoDir, "chore: initial");
	});

	/**
	 * Patch Bun.spawn to return a process that never resolves `exited`, and
	 * simultaneously patch `setTimeout` to fire its callback synchronously so
	 * the test doesn't have to wait 2 seconds for the real timer.
	 */
	async function withHangingGitAndFastTimeout<T>(fn: () => Promise<T>): Promise<T> {
		const originalSpawn = Bun.spawn.bind(Bun);
		const originalSetTimeout = globalThis.setTimeout;

		// @ts-ignore — monkey-patch for test isolation
		Bun.spawn = () => {
			const neverStream = new ReadableStream<Uint8Array>({ start() {} });
			return {
				stdout: neverStream,
				stderr: new ReadableStream<Uint8Array>({ start() {} }),
				exited: new Promise<never>(() => {}), // hangs forever
				kill() {},
			};
		};

		// Fire setTimeout callbacks synchronously so timeout resolves immediately.
		// @ts-ignore — intentional global patch for test isolation
		globalThis.setTimeout = (cb: () => void) => {
			cb();
			return 0 as unknown as Timer;
		};

		try {
			return await fn();
		} finally {
			// @ts-ignore
			Bun.spawn = originalSpawn;
			globalThis.setTimeout = originalSetTimeout;
		}
	}

	it("returns blocked when the git subprocess times out", async () => {
		const invocation = makeInvocation(
			{ kind: "inline", paragraphs: ["feat: timeout test"] },
			repoDir,
		);
		// Must not throw; must resolve to blocked.
		const result = await withHangingGitAndFastTimeout(() => resolveCommit(invocation));
		expect(result.resolution).toBe("blocked");
	});

	it("returns blocked (not a rejection) when timeout fires during worktree resolution", async () => {
		const invocation = makeInvocation({ kind: "generated" }, repoDir);
		const result = await withHangingGitAndFastTimeout(() => resolveCommit(invocation));
		expect(result.resolution).toBe("blocked");
	});
});

// ---------------------------------------------------------------------------
// Global git config is visible via loadGitConfig
// ---------------------------------------------------------------------------

describe("resolveCommit — global git config is honoured", () => {
	let repoDir: string;
	let globalConfigFile: string;

	beforeAll(async () => {
		repoDir = join(tmpBase, "global-config-repo");
		await mkdir(repoDir);
		await initRepo(repoDir);
		await makeCommit(repoDir, "chore: initial");

		// Write a temporary global config that sets commit.cleanup = strip.
		// Point GIT_CONFIG_GLOBAL at it so real user config is never touched.
		globalConfigFile = join(tmpBase, "test-global.gitconfig");
		await writeFile(globalConfigFile, "[commit]\n\tcleanup = strip\n");
	});

	it("reads commit.cleanup from the effective merged config (global scope visible)", async () => {
		const savedGlobal = process.env.GIT_CONFIG_GLOBAL;
		const savedSystem = process.env.GIT_CONFIG_SYSTEM;
		process.env.GIT_CONFIG_GLOBAL = globalConfigFile;
		// Suppress system config so only our file is merged above local.
		process.env.GIT_CONFIG_SYSTEM = "/dev/null";
		try {
			const invocation = makeInvocation(
				{ kind: "inline", paragraphs: ["feat: global config", "# comment line"] },
				repoDir,
			);
			const result = await resolveCommit(invocation);
			expect(result.resolution).toBe("lint");
			if (result.resolution === "lint") {
				// strip removes comment lines; global config must have been read
				expect(result.message).toBe("feat: global config");
				expect(result.message).not.toContain("# comment line");
			}
		} finally {
			if (savedGlobal === undefined) {
				delete process.env.GIT_CONFIG_GLOBAL;
			} else {
				process.env.GIT_CONFIG_GLOBAL = savedGlobal;
			}
			if (savedSystem === undefined) {
				delete process.env.GIT_CONFIG_SYSTEM;
			} else {
				process.env.GIT_CONFIG_SYSTEM = savedSystem;
			}
		}
	});

	it("old local-only query would have missed this; effective query must not", async () => {
		// Verify: if we run git config --local --list --null on this repo (which has
		// no local commit.cleanup), cleanup falls back to default (whitespace for inline).
		// The global config has strip. Effective config must produce strip.
		const savedGlobal = process.env.GIT_CONFIG_GLOBAL;
		const savedSystem = process.env.GIT_CONFIG_SYSTEM;
		process.env.GIT_CONFIG_GLOBAL = globalConfigFile;
		process.env.GIT_CONFIG_SYSTEM = "/dev/null";
		try {
			const invocation = makeInvocation(
				{ kind: "inline", paragraphs: ["fix: subject", "# this is a comment"] },
				repoDir,
			);
			const result = await resolveCommit(invocation);
			expect(result.resolution).toBe("lint");
			if (result.resolution === "lint") {
				// strip from global config must strip the comment line
				expect(result.message).not.toContain("# this is a comment");
			}
		} finally {
			if (savedGlobal === undefined) {
				delete process.env.GIT_CONFIG_GLOBAL;
			} else {
				process.env.GIT_CONFIG_GLOBAL = savedGlobal;
			}
			if (savedSystem === undefined) {
				delete process.env.GIT_CONFIG_SYSTEM;
			} else {
				process.env.GIT_CONFIG_SYSTEM = savedSystem;
			}
		}
	});
});

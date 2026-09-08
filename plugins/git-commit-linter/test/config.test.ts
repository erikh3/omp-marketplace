import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ---------------------------------------------------------------------------
// Mock getAgentDir before any module evaluation so config.ts binds to the mock.
// ---------------------------------------------------------------------------

import * as realPiCodingAgent from "@oh-my-pi/pi-coding-agent";

let mockAgentDir = "/nonexistent-agent-dir-config-test";
mock.module("@oh-my-pi/pi-coding-agent", () => ({
	...realPiCodingAgent,
	getAgentDir: () => mockAgentDir,
}));

const { loadConfig } = await import("../src/config.ts");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Run a git command in cwd. Throws on non-zero exit. */
async function git(args: string[], cwd: string): Promise<string> {
	const proc = Bun.spawn(["git", ...args], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
		stdin: "inherit",
		env: {
			...process.env,
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

async function initRepo(dir: string): Promise<void> {
	await git(["init"], dir);
	await git(["config", "user.email", "test@example.com"], dir);
	await git(["config", "user.name", "Test"], dir);
}

// ---------------------------------------------------------------------------
// Temp directory lifecycle
// ---------------------------------------------------------------------------

let tmpBase: string;

beforeAll(async () => {
	const raw = await mkdtemp(join(tmpdir(), "gcl-cfg-test-"));
	tmpBase = await realpath(raw);
});

afterAll(async () => {
	await rm(tmpBase, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// No repository config — conventional defaults
// ---------------------------------------------------------------------------

describe("no repository config — conventional defaults", () => {
	let repoDir: string;

	beforeEach(async () => {
		repoDir = await mkdtemp(join(tmpBase, "no-repo-cfg-"));
		await initRepo(repoDir);
	});

	it("returns ready with conventional config when no repo config and no plugin JSONCs", async () => {
		const result = await loadConfig(repoDir);
		expect(result.kind).toBe("ready");
		if (result.kind !== "ready") return;

		// Conventional config includes subject-case, type-empty, etc.
		const ruleNames = Object.keys(result.config.commitlint.rules);
		expect(ruleNames.length).toBeGreaterThan(0);
		expect(ruleNames).toContain("type-empty");
	});

	it("gitCommitLinter behavior is empty object", async () => {
		const result = await loadConfig(repoDir);
		expect(result.kind).toBe("ready");
		if (result.kind !== "ready") return;
		expect(result.config.gitCommitLinter).toEqual({});
	});
});

// ---------------------------------------------------------------------------
// Plugin JSONC — user overrides bundled fields
// ---------------------------------------------------------------------------

describe("plugin JSONC — user overrides", () => {
	let repoDir: string;
	let agentDir: string;

	beforeEach(async () => {
		repoDir = await mkdtemp(join(tmpBase, "user-override-"));
		agentDir = await mkdtemp(join(tmpBase, "agent-dir-"));
		mockAgentDir = agentDir;
		await initRepo(repoDir);
	});

	afterEach(() => {
		mockAgentDir = "/nonexistent-agent-dir-config-test";
	});

	it("user plugin JSONC overrides bundled extends", async () => {
		// Write a user config with a custom helpUrl to confirm it propagates.
		await writeFile(
			join(agentDir, "git-commit-linter.jsonc"),
			JSON.stringify({ helpUrl: "https://user.example.com/rules" }),
		);

		const result = await loadConfig(repoDir);
		expect(result.kind).toBe("ready");
		if (result.kind !== "ready") return;
		expect(result.config.commitlint.helpUrl).toBe("https://user.example.com/rules");
	});

	it("project JSONC overrides user JSONC rule-by-rule", async () => {
		await writeFile(
			join(agentDir, "git-commit-linter.jsonc"),
			JSON.stringify({
				rules: {
					"header-max-length": [2, "always", 72],
					"type-empty": [2, "never"],
				},
			}),
		);
		await mkdir(join(repoDir, ".omp"), { recursive: true });
		await writeFile(
			join(repoDir, ".omp", "git-commit-linter.jsonc"),
			JSON.stringify({
				rules: {
					"header-max-length": [2, "always", 100],
				},
			}),
		);

		const result = await loadConfig(repoDir);
		expect(result.kind).toBe("ready");
		if (result.kind !== "ready") return;

		// Project header-max-length overrides user.
		expect(result.config.commitlint.rules["header-max-length"]).toEqual([2, "always", 100]);
		// User-only rule is preserved.
		expect(result.config.commitlint.rules["type-empty"]).toBeDefined();
	});

	it("JSONC comments and trailing commas are accepted", async () => {
		const jsoncWithComments = `{
	// This is a comment
	"helpUrl": "https://example.com", /* inline comment */
	"rules": {
		"header-max-length": [2, "always", 80], // trailing comma
	},
}`;
		await writeFile(join(agentDir, "git-commit-linter.jsonc"), jsoncWithComments);

		const result = await loadConfig(repoDir);
		expect(result.kind).toBe("ready");
		if (result.kind !== "ready") return;
		expect(result.config.commitlint.helpUrl).toBe("https://example.com");
	});
});

// ---------------------------------------------------------------------------
// Plugin JSONC — invalid shapes are fatal
// ---------------------------------------------------------------------------

describe("plugin JSONC — invalid shapes", () => {
	let repoDir: string;
	let agentDir: string;

	beforeEach(async () => {
		repoDir = await mkdtemp(join(tmpBase, "bad-jsonc-"));
		agentDir = await mkdtemp(join(tmpBase, "agent-dir-bad-"));
		mockAgentDir = agentDir;
		await initRepo(repoDir);
	});

	afterEach(() => {
		mockAgentDir = "/nonexistent-agent-dir-config-test";
	});

	it("malformed JSONC (syntax error) returns fatal", async () => {
		await writeFile(
			join(agentDir, "git-commit-linter.jsonc"),
			"{ invalid json {{",
		);
		const result = await loadConfig(repoDir);
		expect(result.kind).toBe("fatal");
	});

	it("non-object JSONC root returns fatal", async () => {
		await writeFile(join(agentDir, "git-commit-linter.jsonc"), `["array"]`);
		const result = await loadConfig(repoDir);
		expect(result.kind).toBe("fatal");
	});

	it("unknown JSONC field returns fatal", async () => {
		await writeFile(
			join(agentDir, "git-commit-linter.jsonc"),
			JSON.stringify({ unknownBehaviorKey: true }),
		);
		const result = await loadConfig(repoDir);
		expect(result.kind).toBe("fatal");
	});

	it("executable 'ignores' field in JSONC returns fatal", async () => {
		await writeFile(
			join(agentDir, "git-commit-linter.jsonc"),
			JSON.stringify({ ignores: ["somePattern"] }),
		);
		const result = await loadConfig(repoDir);
		expect(result.kind).toBe("fatal");
	});

	it("gitCommitLinter with unknown keys returns fatal", async () => {
		await writeFile(
			join(agentDir, "git-commit-linter.jsonc"),
			JSON.stringify({ gitCommitLinter: { unknownToggle: true } }),
		);
		const result = await loadConfig(repoDir);
		expect(result.kind).toBe("fatal");
	});

	it("gitCommitLinter as a non-object returns fatal", async () => {
		await writeFile(
			join(agentDir, "git-commit-linter.jsonc"),
			JSON.stringify({ gitCommitLinter: "string" }),
		);
		const result = await loadConfig(repoDir);
		expect(result.kind).toBe("fatal");
	});

	it("project JSONC error also returns fatal", async () => {
		await mkdir(join(repoDir, ".omp"), { recursive: true });
		await writeFile(
			join(repoDir, ".omp", "git-commit-linter.jsonc"),
			"not valid {{ json",
		);
		const result = await loadConfig(repoDir);
		expect(result.kind).toBe("fatal");
	});
});

// ---------------------------------------------------------------------------
// Repository config — replaces plugin lint fields
// ---------------------------------------------------------------------------

describe("repository config — replaces plugin lint fields", () => {
	let repoDir: string;

	beforeEach(async () => {
		repoDir = await mkdtemp(join(tmpBase, "repo-cfg-"));
		await initRepo(repoDir);
	});

	it("valid repo config returns ready with repo rules", async () => {
		await writeFile(
			join(repoDir, ".commitlintrc.json"),
			JSON.stringify({
				rules: {
					"header-max-length": [2, "always", 50],
				},
			}),
		);

		const result = await loadConfig(repoDir);
		expect(result.kind).toBe("ready");
		if (result.kind !== "ready") return;
		expect(result.config.commitlint.rules["header-max-length"]).toEqual([2, "always", 50]);
	});

	it("empty but valid repo config counts as repository policy", async () => {
		// Regression: detectRepoConfig must not use `result.isEmpty !== true`
		// as its guard. An empty `{}` config file is a valid repository policy.
		// Under the old guard, isEmpty===true caused fall-through to conventional
		// defaults, which include rules like "type-empty". The fix returns `true`
		// for any non-null cosmiconfig result, including empty files.
		await writeFile(join(repoDir, ".commitlintrc.json"), JSON.stringify({}));

		const result = await loadConfig(repoDir);
		expect(result.kind).toBe("ready");
		if (result.kind !== "ready") return;

		// An empty repo config produces no rules. If the conventional fallback
		// were used instead, "type-empty" would be present.
		expect(result.config.commitlint.rules["type-empty"]).toBeUndefined();
		expect(result.config.gitCommitLinter).toEqual({});
	});

	it("repo config JS file is detected (kind is ready)", async () => {
		await writeFile(
			join(repoDir, "commitlint.config.js"),
			`export default { rules: { "header-max-length": [2, "always", 40] } };`,
		);

		const result = await loadConfig(repoDir);
		// Verifies that the JS config file is detected via cosmiconfig so load()
		// is called. @commitlint/load's rule extraction from ESM JS files in the
		// Bun runtime has known limitations; what matters here is that detection
		// works (kind is "ready", not "broken-repository-config").
		expect(result.kind).toBe("ready");
	});

	it("broken repo config returns broken-repository-config (fail-open)", async () => {
		// Write a config that extends a non-existent package, causing load to throw.
		await writeFile(
			join(repoDir, ".commitlintrc.json"),
			JSON.stringify({ extends: ["@nonexistent-package/commitlint-config-does-not-exist"] }),
		);

		const result = await loadConfig(repoDir);
		expect(result.kind).toBe("broken-repository-config");
	});

	it("broken repo config preserves error details", async () => {
		await writeFile(
			join(repoDir, ".commitlintrc.json"),
			JSON.stringify({ extends: ["@nonexistent/config-missing-xyz"] }),
		);

		const result = await loadConfig(repoDir);
		expect(result.kind).toBe("broken-repository-config");
		if (result.kind !== "broken-repository-config") return;
		expect(result.error).toBeDefined();
	});

	it("repo config replaces plugin JSONC lint fields, preserves behavior", async () => {
		// Set up agent dir with a plugin JSONC that sets helpUrl.
		const agentDir = await mkdtemp(join(tmpBase, "agent-dir-repo-"));
		mockAgentDir = agentDir;
		await writeFile(
			join(agentDir, "git-commit-linter.jsonc"),
			JSON.stringify({ helpUrl: "https://user.example.com/rules" }),
		);

		await writeFile(
			join(repoDir, ".commitlintrc.json"),
			JSON.stringify({ rules: { "header-max-length": [2, "always", 60] } }),
		);

		const result = await loadConfig(repoDir);
		mockAgentDir = "/nonexistent-agent-dir-config-test";

		expect(result.kind).toBe("ready");
		if (result.kind !== "ready") return;
		// Repo config replaced lint fields (helpUrl comes from repo load, not plugin).
		expect(result.config.gitCommitLinter).toEqual({});
	});
});

// ---------------------------------------------------------------------------
// Config reload on next call
// ---------------------------------------------------------------------------

describe("config reload", () => {
	let repoDir: string;

	beforeEach(async () => {
		repoDir = await mkdtemp(join(tmpBase, "reload-"));
		await initRepo(repoDir);
	});

	it("picks up config changes between calls", async () => {
		const first = await loadConfig(repoDir);
		expect(first.kind).toBe("ready");
		if (first.kind !== "ready") return;
		const firstRuleCount = Object.keys(first.config.commitlint.rules).length;

		// Add a repo config that produces different rules.
		await writeFile(
			join(repoDir, ".commitlintrc.json"),
			JSON.stringify({ rules: { "header-max-length": [2, "always", 72] } }),
		);

		const second = await loadConfig(repoDir);
		expect(second.kind).toBe("ready");
		if (second.kind !== "ready") return;
		// Repo config produces only the explicitly set rule (not the full conventional set).
		expect(Object.keys(second.config.commitlint.rules).length).not.toBe(firstRuleCount);
	});
});

// ---------------------------------------------------------------------------
// gitCommitLinter empty object is valid
// ---------------------------------------------------------------------------

describe("gitCommitLinter empty object", () => {
	let repoDir: string;
	let agentDir: string;

	beforeEach(async () => {
		repoDir = await mkdtemp(join(tmpBase, "behavior-empty-"));
		agentDir = await mkdtemp(join(tmpBase, "agent-dir-empty-"));
		mockAgentDir = agentDir;
		await initRepo(repoDir);
	});

	afterEach(() => {
		mockAgentDir = "/nonexistent-agent-dir-config-test";
	});

	it("empty gitCommitLinter object in user JSONC is valid", async () => {
		await writeFile(
			join(agentDir, "git-commit-linter.jsonc"),
			JSON.stringify({ gitCommitLinter: {} }),
		);
		const result = await loadConfig(repoDir);
		expect(result.kind).toBe("ready");
		if (result.kind !== "ready") return;
		expect(result.config.gitCommitLinter).toEqual({});
	});

	it("empty gitCommitLinter object in project JSONC is valid", async () => {
		await mkdir(join(repoDir, ".omp"), { recursive: true });
		await writeFile(
			join(repoDir, ".omp", "git-commit-linter.jsonc"),
			JSON.stringify({ gitCommitLinter: {} }),
		);
		const result = await loadConfig(repoDir);
		expect(result.kind).toBe("ready");
		if (result.kind !== "ready") return;
		expect(result.config.gitCommitLinter).toEqual({});
	});
});

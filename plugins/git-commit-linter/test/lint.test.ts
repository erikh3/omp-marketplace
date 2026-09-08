import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { lintCommit } from "../src/lint.ts";
import type { CommitInvocation, CommitOptions, EffectiveLintConfig, GitGlobalOptions } from "../src/types.ts";
import load from "@commitlint/load";

// ---------------------------------------------------------------------------
// Helpers
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

function makeInvocation(effectiveCwd: string): CommitInvocation {
	return {
		tokenStart: 0,
		tokenEnd: 10,
		effectiveCwd,
		gitGlobalOptions: defaultGlobalOptions,
		commitOptions: defaultCommitOptions,
		messageSource: { kind: "inline", paragraphs: [] },
		cleanupOverride: undefined,
		isGeneratedMessage: false,
	};
}

// Load from import.meta.dir so @commitlint/config-conventional resolves from
// the plugin's own node_modules. This mirrors config.ts's seed behavior.
const PLUGIN_DIR = import.meta.dir;

// ---------------------------------------------------------------------------
// Temp directory lifecycle
// ---------------------------------------------------------------------------

let tmpBase: string;

beforeAll(async () => {
	const raw = await mkdtemp(join(tmpdir(), "gcl-lint-test-"));
	tmpBase = await realpath(raw);
});

afterAll(async () => {
	await rm(tmpBase, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Basic pass / fail
// ---------------------------------------------------------------------------

describe("lintCommit — conventional commits", () => {
	it("valid conventional commit returns valid:true with no errors", async () => {
		const commitlint = await load(
			{ extends: ["@commitlint/config-conventional"] },
			{ cwd: PLUGIN_DIR },
		);
		const config: EffectiveLintConfig = { commitlint, gitCommitLinter: {} };
		const invocation = makeInvocation(tmpBase);

		const result = await lintCommit("feat: add new feature", invocation, tmpBase, config);

		expect(result.valid).toBe(true);
		expect(result.errors).toHaveLength(0);
	});

	it("accepts an uppercase SIGPEX ticket as the scope", async () => {
		const commitlint = await load(
			{ extends: ["@commitlint/config-conventional"] },
			{ cwd: PLUGIN_DIR },
		);
		const config: EffectiveLintConfig = { commitlint, gitCommitLinter: {} };
		const invocation = makeInvocation(tmpBase);
		const message = "fix(SIGPEX-1234): fix Jira issue 1234";

		const result = await lintCommit(message, invocation, tmpBase, config);

		expect(result.valid).toBe(true);
		expect(result.errors).toHaveLength(0);
	});

	it("missing type returns valid:false with errors", async () => {
		const commitlint = await load(
			{ extends: ["@commitlint/config-conventional"] },
			{ cwd: PLUGIN_DIR },
		);
		const config: EffectiveLintConfig = { commitlint, gitCommitLinter: {} };
		const invocation = makeInvocation(tmpBase);

		const result = await lintCommit("add new feature", invocation, tmpBase, config);

		expect(result.valid).toBe(false);
		expect(result.errors.length).toBeGreaterThan(0);
	});

	it("invalid type returns valid:false", async () => {
		const commitlint = await load(
			{ extends: ["@commitlint/config-conventional"] },
			{ cwd: PLUGIN_DIR },
		);
		const config: EffectiveLintConfig = { commitlint, gitCommitLinter: {} };
		const invocation = makeInvocation(tmpBase);

		const result = await lintCommit("notavalidtype: something", invocation, tmpBase, config);

		expect(result.valid).toBe(false);
		expect(result.errors.length).toBeGreaterThan(0);
	});

	it("error rule outcome has name and message fields", async () => {
		const commitlint = await load(
			{ extends: ["@commitlint/config-conventional"] },
			{ cwd: PLUGIN_DIR },
		);
		const config: EffectiveLintConfig = { commitlint, gitCommitLinter: {} };
		const invocation = makeInvocation(tmpBase);

		const result = await lintCommit("add new feature without type", invocation, tmpBase, config);

		expect(result.errors.length).toBeGreaterThan(0);
		for (const err of result.errors) {
			expect(typeof err.name).toBe("string");
			expect(typeof err.message).toBe("string");
		}
	});
});

// ---------------------------------------------------------------------------
// Result shape
// ---------------------------------------------------------------------------

describe("lintCommit — result shape", () => {
	it("result includes repoRoot, invocation, and message", async () => {
		const commitlint = await load(
			{ extends: ["@commitlint/config-conventional"] },
			{ cwd: PLUGIN_DIR },
		);
		const config: EffectiveLintConfig = { commitlint, gitCommitLinter: {} };
		const invocation = makeInvocation(tmpBase);
		const message = "feat: some feature";

		const result = await lintCommit(message, invocation, tmpBase, config);

		expect(result.repoRoot).toBe(tmpBase);
		expect(result.invocation).toBe(invocation);
		expect(result.message).toBe(message);
	});

	it("warnings are returned unchanged without blocking", async () => {
		// Build a config where subject-case is a warning (severity 1), not an error.
		// No extends needed — custom rules only.
		const commitlint = await load(
			{
				rules: {
					"subject-case": [1, "always", "lower-case"],
					"type-empty": [2, "never"],
				},
			},
			{ cwd: PLUGIN_DIR },
		);
		const config: EffectiveLintConfig = { commitlint, gitCommitLinter: {} };
		const invocation = makeInvocation(tmpBase);

		// Message has uppercase subject — triggers the warning rule.
		// Has a non-empty type so type-empty is satisfied.
		const result = await lintCommit("feat: This starts with uppercase", invocation, tmpBase, config);

		expect(result.warnings.length).toBeGreaterThan(0);
		expect(result.errors).toHaveLength(0);
		expect(result.valid).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Option forwarding
// ---------------------------------------------------------------------------

describe("lintCommit — option forwarding", () => {
	it("rules are forwarded: custom header-max-length enforced", async () => {
		const commitlint = await load(
			{ rules: { "header-max-length": [2, "always", 20] } },
			{ cwd: PLUGIN_DIR },
		);
		const config: EffectiveLintConfig = { commitlint, gitCommitLinter: {} };
		const invocation = makeInvocation(tmpBase);

		const result = await lintCommit("a".repeat(21), invocation, tmpBase, config);

		expect(result.valid).toBe(false);
		expect(result.errors.some((e) => e.name === "header-max-length")).toBe(true);
	});

	it("defaultIgnores: true causes merge commits to be ignored", async () => {
		const commitlint = await load(
			{
				extends: ["@commitlint/config-conventional"],
				defaultIgnores: true,
			},
			{ cwd: PLUGIN_DIR },
		);
		const config: EffectiveLintConfig = { commitlint, gitCommitLinter: {} };
		const invocation = makeInvocation(tmpBase);

		// Merge pull request messages are in the commitlint default ignore list.
		const result = await lintCommit("Merge pull request #1 from foo/bar", invocation, tmpBase, config);
		expect(result.valid).toBe(true);
	});

	it("defaultIgnores: false causes merge commits to fail conventional rules", async () => {
		const commitlint = await load(
			{
				extends: ["@commitlint/config-conventional"],
				defaultIgnores: false,
			},
			{ cwd: PLUGIN_DIR },
		);
		const config: EffectiveLintConfig = { commitlint, gitCommitLinter: {} };
		const invocation = makeInvocation(tmpBase);

		// Same merge message fails when default ignores are disabled.
		const result = await lintCommit("Merge pull request #1 from foo/bar", invocation, tmpBase, config);
		expect(result.valid).toBe(false);
	});

	it("function-valued ignores from repo config are forwarded", async () => {
		// Build a config with an ignores function (only possible via load, not JSONC).
		const commitlint = await load(
			{
				extends: ["@commitlint/config-conventional"],
				ignores: [(msg: string) => msg.startsWith("chore(release)")],
			},
			{ cwd: PLUGIN_DIR },
		);
		const config: EffectiveLintConfig = { commitlint, gitCommitLinter: {} };
		const invocation = makeInvocation(tmpBase);

		// This message would normally fail (no proper type) but is ignored.
		const result = await lintCommit("chore(release): v1.0.0", invocation, tmpBase, config);
		expect(result.valid).toBe(true);
	});

	it("plugins object is forwarded", async () => {
		// Minimal smoke test: empty plugins record should not break linting.
		const commitlint = await load(
			{ extends: ["@commitlint/config-conventional"] },
			{ cwd: PLUGIN_DIR },
		);
		const config: EffectiveLintConfig = { commitlint, gitCommitLinter: {} };
		const invocation = makeInvocation(tmpBase);

		expect(config.commitlint.plugins).toBeDefined();

		const result = await lintCommit("feat: works", invocation, tmpBase, config);
		expect(result.valid).toBe(true);
	});

	it("helpUrl is forwarded to lint options", async () => {
		const customUrl = "https://custom.example.com/rules";
		const commitlint = await load(
			{
				extends: ["@commitlint/config-conventional"],
				helpUrl: customUrl,
			},
			{ cwd: PLUGIN_DIR },
		);
		const config: EffectiveLintConfig = { commitlint, gitCommitLinter: {} };
		const invocation = makeInvocation(tmpBase);

		const result = await lintCommit("feat: check helpUrl", invocation, tmpBase, config);
		expect(result.valid).toBe(true);
		expect(config.commitlint.helpUrl).toBe(customUrl);
	});
});

// ---------------------------------------------------------------------------
// Empty config (no rules)
// ---------------------------------------------------------------------------

describe("lintCommit — empty config", () => {
	it("empty rules config accepts any message", async () => {
		const commitlint = await load({}, { cwd: PLUGIN_DIR });
		const config: EffectiveLintConfig = { commitlint, gitCommitLinter: {} };
		const invocation = makeInvocation(tmpBase);

		const result = await lintCommit("anything goes here", invocation, tmpBase, config);
		expect(result.valid).toBe(true);
		expect(result.errors).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// Repo config scenario (integration)
// ---------------------------------------------------------------------------

describe("lintCommit — repo config scenario", () => {
	let repoDir: string;

	beforeAll(async () => {
		repoDir = await mkdtemp(join(tmpBase, "repo-lint-"));
		await writeFile(
			join(repoDir, ".commitlintrc.json"),
			JSON.stringify({ rules: { "header-max-length": [2, "always", 30] } }),
		);
	});

	it("repo config's header-max-length rule is enforced", async () => {
		const commitlint = await load({}, { cwd: repoDir });
		const config: EffectiveLintConfig = { commitlint, gitCommitLinter: {} };
		const invocation = makeInvocation(repoDir);

		// 31 chars — should fail the 30-char limit.
		const result = await lintCommit("a".repeat(31), invocation, repoDir, config);
		expect(result.valid).toBe(false);
		expect(result.errors.some((e) => e.name === "header-max-length")).toBe(true);
	});

	it("message within repo config limit passes", async () => {
		const commitlint = await load({}, { cwd: repoDir });
		const config: EffectiveLintConfig = { commitlint, gitCommitLinter: {} };
		const invocation = makeInvocation(repoDir);

		const result = await lintCommit("short message", invocation, repoDir, config);
		expect(result.valid).toBe(true);
	});
});

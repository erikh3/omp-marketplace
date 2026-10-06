import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import type { CommandResult } from "../src/backends.ts";
import { detectStagingRepositories } from "../src/bash-policy.ts";
import { StageAdvisor } from "../src/stage-advisor.ts";

describe("detectStagingRepositories", () => {
	test("detects add, commit, and stage through env prefixes, command, and -C", () => {
		expect(detectStagingRepositories("git add -A", "/repo")).toEqual(["/repo"]);
		expect(detectStagingRepositories("GIT_PAGER=cat command git commit -m x", "/repo")).toEqual(["/repo"]);
		expect(detectStagingRepositories("git -C sub stage file.ts", "/repo")).toEqual([join("/repo", "sub")]);
	});

	test("resolves one hint per staging segment in a chain", () => {
		expect(detectStagingRepositories("git add . && git -C other commit -m y", "/repo")).toEqual([
			"/repo",
			join("/repo", "other"),
		]);
	});

	test("ignores non-staging git subcommands and non-git commands", () => {
		expect(detectStagingRepositories("git status", "/repo")).toEqual([]);
		expect(detectStagingRepositories("git worktree add /tmp/wt HEAD", "/repo")).toEqual([]);
		expect(detectStagingRepositories("npm run add", "/repo")).toEqual([]);
		expect(detectStagingRepositories("gitlab add", "/repo")).toEqual([]);
	});
});

/** Fake runner whose rev-parse output encodes primary vs linked worktree. */
function runner(gitDir: string, commonDir: string, code = 0) {
	const calls: Array<{ args: string[]; cwd?: string }> = [];
	const exec = async (_command: string, args: string[], options?: { cwd?: string }): Promise<CommandResult> => {
		calls.push({ args, cwd: options?.cwd });
		return { stdout: `${gitDir}\n${commonDir}\n`, stderr: "", code };
	};
	return { runner: { exec }, calls };
}

describe("StageAdvisor", () => {
	test("hints once when staging in the primary worktree", async () => {
		const { runner: r, calls } = runner("/repo/.git", "/repo/.git");
		const advisor = new StageAdvisor(r);

		advisor.observe("call-1", "git add -A", "/repo");
		const first = await advisor.complete("call-1", false);
		expect(first).toContain("worktree_manager");
		expect(calls[0]?.cwd).toBe("/repo");

		advisor.observe("call-2", "git commit -m next", "/repo");
		expect(await advisor.complete("call-2", false)).toBeUndefined();
	});

	test("stays silent inside a linked worktree", async () => {
		const { runner: r } = runner("/repo/.git/worktrees/topic", "/repo/.git");
		const advisor = new StageAdvisor(r);

		advisor.observe("call-1", "git add -A", "/repo/.omp/worktrees/topic");
		expect(await advisor.complete("call-1", false)).toBeUndefined();
	});

	test("does not hint for non-staging commands", async () => {
		const { runner: r, calls } = runner("/repo/.git", "/repo/.git");
		const advisor = new StageAdvisor(r);

		advisor.observe("call-1", "git status", "/repo");
		expect(await advisor.complete("call-1", false)).toBeUndefined();
		expect(calls).toHaveLength(0);
	});

	test("suppresses the hint when the staging command failed", async () => {
		const { runner: r, calls } = runner("/repo/.git", "/repo/.git");
		const advisor = new StageAdvisor(r);

		advisor.observe("call-1", "git add missing", "/repo");
		expect(await advisor.complete("call-1", true)).toBeUndefined();
		expect(calls).toHaveLength(0);
	});

	test("stays silent when rev-parse fails", async () => {
		const { runner: r } = runner("", "", 128);
		const advisor = new StageAdvisor(r);

		advisor.observe("call-1", "git add -A", "/repo");
		expect(await advisor.complete("call-1", false)).toBeUndefined();
	});
});

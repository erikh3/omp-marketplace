import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { GitBackend, HerdrBackend } from "../src/backends.ts";
import { IncidentStore } from "../src/incident-store.ts";
import { WorktreeService } from "../src/worktree-service.ts";
import { WorktreeManagerError } from "../src/validation.ts";

const directories: string[] = [];

afterEach(async () => {
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function temporaryRepository() {
	const directory = await mkdtemp(join(tmpdir(), "worktree-manager-test-"));
	directories.push(directory);
	return realpath(directory);
}

function runnerFor(root: string, worktreeOutput = "") {
	const calls: Array<{ command: string; args: string[] }> = [];
	return {
		calls,
		exec: async (command: string, args: string[]) => {
			calls.push({ command, args });
			if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return { stdout: `${root}\n`, stderr: "", code: 0 };
			if (args[0] === "worktree" && args[1] === "list") return { stdout: worktreeOutput, stderr: "", code: 0 };
			return { stdout: "", stderr: "", code: 0 };
		},
	};
}

describe("WorktreeService", () => {
	test("creates slash-containing branches inside .omp/worktrees while preserving flags", async () => {
		const root = await temporaryRepository();
		const runner = runnerFor(root);
		const service = new WorktreeService(runner, new IncidentStore(join(root, "incidents.json")), new GitBackend(runner));

		const result = await service.execute({
			action: "create",
			repository: root,
			branch: "feature/nested",
			baseRef: "HEAD",
			gitGlobalArgs: ["--no-pager"],
			worktreeArgs: ["--force"],
		});

		expect(result.path).toBe(join(root, ".omp", "worktrees", "feature", "nested"));
		expect(runner.calls.at(-1)?.args).toEqual([
			"--no-pager",
			"worktree",
			"add",
			"--force",
			"-b",
			"feature/nested",
			join(root, ".omp", "worktrees", "feature", "nested"),
			"HEAD",
		]);
	});

	test("lists unmanaged Git worktrees", async () => {
		const root = await temporaryRepository();
		const unmanaged = join(root, "../unmanaged");
		const runner = runnerFor(root, `worktree ${root}\nHEAD abc\nbranch refs/heads/main\n\nworktree ${unmanaged}\nHEAD def\nbranch refs/heads/topic\n`);
		const service = new WorktreeService(runner, new IncidentStore(join(root, "incidents.json")), new GitBackend(runner));

		const result = await service.execute({ action: "list", repository: root, gitGlobalArgs: [], worktreeArgs: [] });

		expect(result.worktrees).toEqual([
			{ path: root, branch: "main", isMain: true },
			{ path: unmanaged, branch: "topic", isMain: false },
		]);
	});

	test("relocates a linked worktree and clears its incident", async () => {
		const root = await temporaryRepository();
		const outside = await mkdtemp(join(tmpdir(), "worktree-manager-outside-"));
		directories.push(outside);
		const source = await realpath(outside);
		const runner = runnerFor(root, `worktree ${root}\nbranch refs/heads/main\n\nworktree ${source}\nbranch refs/heads/topic\n`);
		const incidents = new IncidentStore(join(root, "incidents.json"));
		await incidents.record({ repository: root, path: source, backend: "git", expected: join(root, ".omp", "worktrees"), createdAt: "2026-01-01T00:00:00.000Z" });
		const service = new WorktreeService(runner, incidents, new GitBackend(runner));

		const result = await service.execute({ action: "relocate", repository: root, path: source, gitGlobalArgs: [], worktreeArgs: [] });

		expect(result.path).toBe(join(root, ".omp", "worktrees", "topic"));
		expect(runner.calls.at(-1)?.args).toEqual(["worktree", "move", source, join(root, ".omp", "worktrees", "topic")]);
		expect(await incidents.list(root)).toEqual([]);
	});

	test("rejects passthrough arguments that replace managed inputs", async () => {
		const root = await temporaryRepository();
		const runner = runnerFor(root);
		const service = new WorktreeService(runner, new IncidentStore(join(root, "incidents.json")), new GitBackend(runner));

		await expect(service.execute({
			action: "create",
			repository: root,
			branch: "topic",
			baseRef: "HEAD",
			gitGlobalArgs: [],
			worktreeArgs: ["-b"],
		})).rejects.toBeInstanceOf(WorktreeManagerError);
	});

	test("uses Herdr's explicit create contract and returned path", async () => {
		const root = await temporaryRepository();
		const path = join(root, "herdr-topic");
		const calls: Array<{ command: string; args: string[] }> = [];
		const runner = {
			exec: async (command: string, args: string[]) => {
				calls.push({ command, args });
				return {
					stdout: JSON.stringify({ result: { worktree: { branch: "topic", path } } }),
					stderr: "",
					code: 0,
				};
			},
		};
		const backend = new HerdrBackend(runner, true);

		const result = await backend.create({
			action: "create",
			repository: root,
			branch: "topic",
			baseRef: "main",
			gitGlobalArgs: [],
			worktreeArgs: [],
		}, { repository: root });

		expect(backend.isAvailable()).toBeTrue();
		expect(result.path).toBe(path);
		expect(calls).toEqual([{ command: "herdr", args: ["worktree", "create", "--cwd", root, "--branch", "topic", "--base", "main", "--no-focus"] }]);
	});
});

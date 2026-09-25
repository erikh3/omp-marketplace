import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";

import { AdvisoryTracker } from "../src/advisory.ts";
import { GitBackend } from "../src/backends.ts";
import { IncidentStore } from "../src/incident-store.ts";
import { WorktreeService } from "../src/worktree-service.ts";

const directories: string[] = [];

afterEach(async () => {
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function context(callbacks: Array<() => void> = []) {
	const scheduled = new Set<symbol>();
	return {
		setTimeout: (callback: (...args: unknown[]) => void, _milliseconds?: number) => {
			const timer = Symbol("managed-timer");
			scheduled.add(timer);
			callbacks.push(() => callback());
			return timer as unknown as NodeJS.Timer;
		},
		clearTimer: (timer: NodeJS.Timer) => scheduled.delete(timer as unknown as symbol),
	} as unknown as ExtensionContext;
}

async function setup() {
	const root = await realpath(await mkdtemp(join(tmpdir(), "worktree-manager-advisory-")));
	directories.push(root);
	const runner = {
		exec: async (_command: string, args: string[]) => ({
			stdout: args[0] === "rev-parse" ? `${root}\n` : "",
			stderr: "",
			code: 0,
		}),
	};
	const incidents = new IncidentStore(join(root, "incidents.json"));
	return { root, incidents, tracker: new AdvisoryTracker(new WorktreeService(runner, incidents, new GitBackend(runner)), incidents) };
}

describe("AdvisoryTracker", () => {
	test("adds a result-only reminder and persists an outside worktree incident", async () => {
		const { root, incidents, tracker } = await setup();
		const outside = await mkdtemp(join(tmpdir(), "worktree-manager-outside-advisory-"));
		directories.push(outside);
		const path = await realpath(outside);
		const ctx = context();

		await tracker.observe("call-1", `git --no-pager worktree add -b topic ${path} HEAD`, root, ctx);
		const reminder = await tracker.complete("call-1", false, ctx);

		expect(reminder).toContain("Created worktree violates the configured git placement policy.");
		expect(await incidents.list(root)).toEqual([expect.objectContaining({ path, backend: "git" })]);
	});

	test("does not advise for the Git backend managed root", async () => {
		const { root, tracker } = await setup();
		const destination = join(root, ".omp", "worktrees", "topic");
		await mkdir(destination, { recursive: true });
		const ctx = context();

		await tracker.observe("call-2", `command git -C ${root} worktree add ${destination} HEAD`, root, ctx);

		expect(await tracker.complete("call-2", false, ctx)).toBeUndefined();
	});

	test("expires unmatched observations without producing a later reminder", async () => {
		const { root, tracker } = await setup();
		const outside = await mkdtemp(join(tmpdir(), "worktree-manager-outside-expiry-"));
		directories.push(outside);
		const callbacks: Array<() => void> = [];
		const ctx = context(callbacks);

		await tracker.observe("call-expiry", `git worktree add ${outside} HEAD`, root, ctx);
		callbacks.forEach((callback) => callback());

		expect(await tracker.complete("call-expiry", false, ctx)).toBeUndefined();
	});
});

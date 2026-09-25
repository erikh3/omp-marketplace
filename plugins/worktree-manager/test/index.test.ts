import { afterEach, expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

import worktreeManager from "../src/index.ts";

import { IncidentStore } from "../src/incident-store.ts";

const directories: string[] = [];

afterEach(async () => {
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

test("registers a lifecycle tool and lets direct worktree Bash calls continue", async () => {
	const root = await realpath(await mkdtemp(join(tmpdir(), "worktree-manager-index-")));
	directories.push(root);
	const handlers: Record<string, (event: unknown, ctx: ExtensionContext) => Promise<unknown> | unknown> = {};
	let tool: { name: string; execute: (id: string, params: unknown, signal?: AbortSignal) => Promise<{ content: Array<{ text: string }> }> } | undefined;
	const messages: string[] = [];
	const schema = {
		describe: () => schema,
		optional: () => schema,
	};
	const z = {
		array: () => schema,
		enum: () => schema,
		object: () => schema,
		string: () => schema,
	};
	const api = {
		zod: z,
		exec: async (_command: string, args: string[]) => ({
			stdout: args[0] === "rev-parse" ? `${root}\n` : "",
			stderr: "",
			code: 0,
			killed: false,
		}),
		sendMessage: (content: string) => {
			messages.push(content);
		},
		on: (event: string, handler: (payload: unknown, ctx: ExtensionContext) => unknown) => {
			handlers[event] = handler;
		},
		registerTool: (registered: typeof tool) => {
			tool = registered;
		},
	} as unknown as ExtensionAPI;
	const context = {
		cwd: root,
		setTimeout: () => Symbol("timer"),
		clearTimer: () => {},
	} as unknown as ExtensionContext;
	const incidents = new IncidentStore(join(root, "incidents.json"));
	await incidents.record({
		repository: root,
		path: join(root, "outside"),
		backend: "git",
		expected: join(root, ".omp", "worktrees"),
		createdAt: "2026-01-01T00:00:00.000Z",
	});

	const priorHerdr = process.env["HERDR_ENV"];
	delete process.env["HERDR_ENV"];
	worktreeManager(api, { incidents });
	if (priorHerdr === undefined) delete process.env["HERDR_ENV"];
	else process.env["HERDR_ENV"] = priorHerdr;

	expect(tool?.name).toBe("worktree_manager");
	await handlers["session_start"]?.({}, context);
	expect(messages[0]).toContain("Unresolved git placement incident.");
	expect(await handlers["tool_call"]?.({
		toolName: "bash",
		toolCallId: "bash-1",
		input: { command: `git worktree add ${join(root, ".omp", "worktrees", "topic")} HEAD` },
	}, context)).toBeUndefined();
	const result = await tool?.execute("tool-1", { action: "list", repository: root });
	expect(result?.content[0]?.text).toContain("Worktrees:");
});

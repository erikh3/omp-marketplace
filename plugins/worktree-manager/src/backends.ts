import { existsSync } from "node:fs";
import { mkdir, realpath } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";

import {
	resolveManagedPath,
	validateGitPassthrough,
	WorktreeManagerError,
} from "./validation.ts";
import type { WorktreeRequest } from "./validation.ts";

export interface CommandResult {
	stdout: string;
	stderr: string;
	code: number;
}

export interface CommandRunner {
	exec(command: string, args: string[], options?: { cwd?: string; signal?: AbortSignal }): Promise<CommandResult>;
}

export interface GitWorktree {
	path: string;
	branch?: string;
	isMain: boolean;
	isPrunable: boolean;
}

export type PlacementPolicy =
	| { kind: "local"; expected: string; managedRoot: string }
	| { kind: "external"; expected: string };

export interface BackendContext {
	repository: string;
	signal?: AbortSignal;
}

export interface WorktreeBackend {
	readonly id: string;
	isAvailable(): boolean;
	placementPolicy(context: BackendContext): Promise<PlacementPolicy>;
	create(request: WorktreeRequest, context: BackendContext): Promise<{ path: string; policy: PlacementPolicy }>;
	listAll(context: BackendContext): Promise<GitWorktree[]>;
	remove(request: WorktreeRequest, context: BackendContext): Promise<void>;
}

export function parseGitWorktrees(output: string): GitWorktree[] {
	const blocks = output.trim().split("\n\n").filter(Boolean);
	return blocks.flatMap((block, index) => {
		const values: Record<string, string> = {};
		for (const line of block.split("\n")) {
			const separator = line.indexOf(" ");
			if (separator > 0) values[line.slice(0, separator)] = line.slice(separator + 1);
		}
		if (!values["worktree"]) return [];
		return [{
			path: values["worktree"],
			branch: values["branch"]?.replace("refs/heads/", ""),
			isMain: index === 0,
			isPrunable: values["prunable"] !== undefined,
		}];
	});
}

async function requireSuccess(
	runner: CommandRunner,
	command: string,
	args: string[],
	context: BackendContext,
	description: string,
): Promise<CommandResult> {
	const result = await runner.exec(command, args, { cwd: context.repository, signal: context.signal });
	if (result.code !== 0) {
		const detail = (result.stderr || result.stdout).trim();
		throw new WorktreeManagerError(`${description}${detail ? `: ${detail}` : ""}`);
	}
	return result;
}

async function listGitWorktrees(runner: CommandRunner, context: BackendContext): Promise<GitWorktree[]> {
	const result = await requireSuccess(runner, "git", ["worktree", "list", "--porcelain"], context, "Cannot list Git worktrees");
	return parseGitWorktrees(result.stdout);
}

/** Git placement adapter for durable worktrees managed below the repository. */
export class GitBackend implements WorktreeBackend {
	readonly id = "git";

	constructor(private readonly runner: CommandRunner) {}

	isAvailable(): boolean {
		return true;
	}

	async placementPolicy(context: BackendContext): Promise<PlacementPolicy> {
		return {
			kind: "local",
			expected: resolve(context.repository, ".omp", "worktrees"),
			managedRoot: resolve(context.repository, ".omp", "worktrees"),
		};
	}

	async create(request: WorktreeRequest, context: BackendContext): Promise<{ path: string; policy: PlacementPolicy }> {
		if (!request.branch || !request.baseRef) throw new WorktreeManagerError("create requires branch and baseRef");
		validateGitPassthrough(request.gitGlobalArgs, request.worktreeArgs);
		await requireSuccess(this.runner, "git", ["check-ref-format", "--branch", request.branch], context, "Invalid branch");
		await requireSuccess(this.runner, "git", ["rev-parse", "--verify", "--quiet", `${request.baseRef}^{commit}`], context, "Invalid base ref");

		const destination = resolveManagedPath(context.repository, request.branch);
		if (existsSync(destination)) throw new WorktreeManagerError(`Worktree destination already exists: ${destination}`);
		await mkdir(dirname(destination), { recursive: true });
		await requireSuccess(
			this.runner,
			"git",
			[...request.gitGlobalArgs, "worktree", "add", ...request.worktreeArgs, "-b", request.branch, destination, request.baseRef],
			context,
			"Cannot create Git worktree",
		);
		return { path: destination, policy: await this.placementPolicy(context) };
	}

	listAll(context: BackendContext): Promise<GitWorktree[]> {
		return listGitWorktrees(this.runner, context);
	}


	async remove(request: WorktreeRequest, context: BackendContext): Promise<void> {
		if (!request.path) throw new WorktreeManagerError("remove requires a worktree path");
		validateGitPassthrough(request.gitGlobalArgs, request.worktreeArgs);
		const source = await realpath(request.path).catch(() => {
			throw new WorktreeManagerError(`Worktree path does not exist: ${request.path}`);
		});
		const worktree = (await listGitWorktrees(this.runner, context)).find((entry) => entry.path === source);
		if (!worktree) throw new WorktreeManagerError(`Path is not a worktree for ${context.repository}: ${source}`);
		if (worktree.isMain) throw new WorktreeManagerError("Cannot remove the main worktree");
		await requireSuccess(
			this.runner,
			"git",
			[...request.gitGlobalArgs, "worktree", "remove", ...request.worktreeArgs, source],
			context,
			"Cannot remove Git worktree",
		);
	}
}

function parseJson(output: string, description: string): Record<string, unknown> {
	try {
		const parsed: unknown = JSON.parse(output);
		if (!parsed || typeof parsed !== "object") throw new Error("not an object");
		return parsed as Record<string, unknown>;
	} catch (error) {
		throw new WorktreeManagerError(`${description}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

function findHerdrPath(value: unknown, branch: string): string | undefined {
	if (!value || typeof value !== "object") return undefined;
	const object = value as Record<string, unknown>;
	if (object["branch"] === branch) {
		const path = object["path"];
		if (typeof path === "string") return path;
		const checkoutPath = object["checkout_path"];
		if (typeof checkoutPath === "string") return checkoutPath;
	}
	for (const child of Object.values(object)) {
		const found = findHerdrPath(child, branch);
		if (found) return found;
	}
	return undefined;
}

function validateHerdrPassthrough(request: WorktreeRequest): void {
	if (request.gitGlobalArgs.length > 0) {
		throw new WorktreeManagerError("Herdr backend does not accept Git global arguments");
	}
	for (const argument of request.worktreeArgs) {
		if (argument !== "--trust-repository") {
			throw new WorktreeManagerError(`Herdr backend does not support worktree argument ${argument}`);
		}
	}
}

/** Herdr placement adapter. Herdr chooses its own worktree location. */
export class HerdrBackend implements WorktreeBackend {
	readonly id = "herdr";

	constructor(private readonly runner: CommandRunner, private readonly enabled = process.env["HERDR_ENV"] === "1") {}

	isAvailable(): boolean {
		return this.enabled;
	}

	async placementPolicy(_context: BackendContext): Promise<PlacementPolicy> {
		return { kind: "external", expected: "the Herdr-managed worktree placement" };
	}

	async create(request: WorktreeRequest, context: BackendContext): Promise<{ path: string; policy: PlacementPolicy }> {
		if (!request.branch || !request.baseRef) throw new WorktreeManagerError("create requires branch and baseRef");
		validateHerdrPassthrough(request);
		const result = await requireSuccess(
			this.runner,
			"herdr",
			["worktree", "create", "--cwd", context.repository, "--branch", request.branch, "--base", request.baseRef, "--no-focus", ...request.worktreeArgs],
			context,
			"Cannot create Herdr worktree",
		);
		const path = findHerdrPath(parseJson(result.stdout, "Herdr returned invalid creation JSON"), request.branch);
		if (!path) throw new WorktreeManagerError("Herdr creation result did not report the created worktree path");
		return { path, policy: { kind: "external", expected: `the Herdr-managed placement containing ${dirname(path)}` } };
	}

	async listAll(context: BackendContext): Promise<GitWorktree[]> {
		const result = await requireSuccess(this.runner, "herdr", ["worktree", "list", "--cwd", context.repository], context, "Cannot list Herdr worktrees");
		const document = parseJson(result.stdout, "Herdr returned invalid list JSON");
		const root = document["result"];
		if (!root || typeof root !== "object" || !("worktrees" in root) || !Array.isArray(root.worktrees)) {
			throw new WorktreeManagerError("Herdr list result did not include worktrees");
		}
		return root.worktrees.flatMap((entry: unknown) => {
			if (!entry || typeof entry !== "object" || !("path" in entry) || typeof entry.path !== "string") return [];
			return [{
				path: entry.path,
				branch: "branch" in entry && typeof entry.branch === "string" ? entry.branch : undefined,
				isMain: !("is_linked_worktree" in entry) || entry.is_linked_worktree !== true,
				isPrunable: "is_prunable" in entry && entry.is_prunable === true,
			}];
		});
	}


	async remove(request: WorktreeRequest, context: BackendContext): Promise<void> {
		if (!request.path) throw new WorktreeManagerError("remove requires a worktree path");
		validateHerdrPassthrough(request);
		const open = await requireSuccess(
			this.runner,
			"herdr",
			["worktree", "open", "--cwd", context.repository, "--path", request.path, "--no-focus", ...request.worktreeArgs],
			context,
			"Cannot resolve Herdr worktree workspace",
		);
		const workspace = findWorkspaceId(parseJson(open.stdout, "Herdr returned invalid open JSON"));
		if (!workspace) throw new WorktreeManagerError("Herdr open result did not report a workspace ID");
		await requireSuccess(this.runner, "herdr", ["worktree", "remove", "--workspace", workspace, ...request.worktreeArgs], context, "Cannot remove Herdr worktree");
	}
}

function findWorkspaceId(value: unknown): string | undefined {
	if (!value || typeof value !== "object") return undefined;
	const object = value as Record<string, unknown>;
	for (const field of ["workspace_id", "workspaceId"]) {
		if (typeof object[field] === "string") return object[field];
	}
	for (const child of Object.values(object)) {
		const found = findWorkspaceId(child);
		if (found) return found;
	}
	return undefined;
}

export function selectBackend(runner: CommandRunner, herdrEnabled = process.env["HERDR_ENV"] === "1"): WorktreeBackend {
	const herdr = new HerdrBackend(runner, herdrEnabled);
	return herdr.isAvailable() ? herdr : new GitBackend(runner);
}

export function describeRepository(repository: string): string {
	return basename(repository);
}

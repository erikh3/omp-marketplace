import { realpath } from "node:fs/promises";

import { selectBackend } from "./backends.ts";
import type { CommandRunner, PlacementPolicy, WorktreeBackend } from "./backends.ts";
import { IncidentStore } from "./incident-store.ts";
import { requireCreateRequest, requirePathRequest, WorktreeManagerError } from "./validation.ts";
import type { WorktreeRequest } from "./validation.ts";

export interface WorktreeServiceResult {
	backend: string;
	repository: string;
	path?: string;
	branch?: string;
	worktrees?: Array<{ path: string; branch?: string; isMain: boolean }>;
	placement?: PlacementPolicy;
}

/** Coordinates repository validation, backend lifecycle calls, and incident resolution. */
export class WorktreeService {
	private readonly backend: WorktreeBackend;

	constructor(
		private readonly runner: CommandRunner,
		private readonly incidents: IncidentStore,
		backend?: WorktreeBackend,
	) {
		this.backend = backend ?? selectBackend(runner);
	}

	async execute(request: WorktreeRequest, signal?: AbortSignal): Promise<WorktreeServiceResult> {
		const repository = await this.resolveRepository(request.repository, signal);
		const context = { repository, signal };

		switch (request.action) {
			case "create": {
				requireCreateRequest(request);
				const created = await this.backend.create(request, context);
				return {
					backend: this.backend.id,
					repository,
					branch: request.branch,
					path: created.path,
					placement: created.policy,
				};
			}
			case "list": {
				const worktrees = await this.backend.listAll(context);
				return { backend: this.backend.id, repository, worktrees };
			}
			case "relocate": {
				requirePathRequest(request);
				const originalPath = await this.canonicalPath(request.path);
				const moved = await this.backend.relocate({ ...request, path: originalPath }, context);
				await this.incidents.clear(repository, originalPath);
				return {
					backend: this.backend.id,
					repository,
					path: moved.path,
					placement: moved.policy,
				};
			}
			case "remove": {
				requirePathRequest(request);
				const originalPath = await this.canonicalPath(request.path);
				await this.backend.remove({ ...request, path: originalPath }, context);
				await this.incidents.clear(repository, originalPath);
				return { backend: this.backend.id, repository, path: originalPath };
			}
		}
	}

	async resolveRepository(repository: string, signal?: AbortSignal): Promise<string> {
		const submitted = await realpath(repository).catch(() => {
			throw new WorktreeManagerError(`Repository path does not exist: ${repository}`);
		});
		const result = await this.runner.exec("git", ["rev-parse", "--show-toplevel"], { cwd: submitted, signal });
		if (result.code !== 0) {
			const detail = (result.stderr || result.stdout).trim();
			throw new WorktreeManagerError(`Repository is not a Git worktree${detail ? `: ${detail}` : ""}`);
		}
		const root = await realpath(result.stdout.trim()).catch(() => {
			throw new WorktreeManagerError("Git did not return a repository root");
		});
		if (submitted !== root) {
			throw new WorktreeManagerError(`Repository must be its Git top-level directory: ${root}`);
		}
		return root;
	}

	async placementForRepository(repository: string, signal?: AbortSignal): Promise<{ repository: string; backend: string; policy: PlacementPolicy }> {
		const root = await this.resolveRepository(repository, signal);
		return {
			repository: root,
			backend: this.backend.id,
			policy: await this.backend.placementPolicy({ repository: root, signal }),
		};
	}

	private async canonicalPath(path: string): Promise<string> {
		return realpath(path).catch(() => {
			throw new WorktreeManagerError(`Worktree path does not exist: ${path}`);
		});
	}
}

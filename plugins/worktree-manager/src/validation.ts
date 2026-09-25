import { relative, resolve, sep } from "node:path";

export type WorktreeAction = "create" | "list" | "relocate" | "remove";

export interface WorktreeRequest {
	action: WorktreeAction;
	repository: string;
	branch?: string;
	baseRef?: string;
	path?: string;
	gitGlobalArgs: string[];
	worktreeArgs: string[];
}

export class WorktreeManagerError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "WorktreeManagerError";
	}
}

export function isPathWithin(path: string, parent: string): boolean {
	const relation = relative(parent, path);
	return relation === "" || (!relation.startsWith(`..${sep}`) && relation !== "..");
}

export function resolveManagedPath(repository: string, branch: string): string {
	const managedRoot = resolve(repository, ".omp", "worktrees");
	const destination = resolve(managedRoot, branch);
	if (!isPathWithin(destination, managedRoot)) {
		throw new WorktreeManagerError("Branch resolves outside the managed worktree root");
	}
	return destination;
}

const GLOBAL_CONFLICTS: Record<string, true> = {
	"-C": true,
	"--git-dir": true,
	"--work-tree": true,
	"--bare": true,
	"--namespace": true,
	"--super-prefix": true,
};

const WORKTREE_CONFLICTS: Record<string, true> = {
	add: true,
	list: true,
	move: true,
	remove: true,
	prune: true,
	repair: true,
	lock: true,
	unlock: true,
	"-b": true,
	"-B": true,
	"--branch": true,
	"--detach": true,
	"--guess-remote": true,
};

function matchesOption(argument: string, option: string): boolean {
	return argument === option || argument.startsWith(`${option}=`);
}

/** Rejects only arguments that can replace values owned by this plugin. */
export function validateGitPassthrough(
	gitGlobalArgs: readonly string[],
	worktreeArgs: readonly string[],
): void {
	for (const argument of gitGlobalArgs) {
		for (const option in GLOBAL_CONFLICTS) {
			if (matchesOption(argument, option)) {
				throw new WorktreeManagerError(`Git global argument ${argument} overrides the repository selection`);
			}
		}
		if (argument === "worktree") {
			throw new WorktreeManagerError("Git global arguments must not select the worktree command");
		}
	}

	for (const argument of worktreeArgs) {
		for (const option in WORKTREE_CONFLICTS) {
			if (matchesOption(argument, option)) {
				throw new WorktreeManagerError(`Git worktree argument ${argument} overrides plugin-owned operation data`);
			}
		}
		if (!argument.startsWith("-")) {
			throw new WorktreeManagerError(`Git worktree argument ${argument} may replace a managed positional argument`);
		}
	}
}

export function requireCreateRequest(request: WorktreeRequest): asserts request is WorktreeRequest & {
	branch: string;
	baseRef: string;
} {
	if (!request.branch?.trim()) throw new WorktreeManagerError("create requires a branch");
	if (!request.baseRef?.trim()) throw new WorktreeManagerError("create requires a baseRef");
}

export function requirePathRequest(request: WorktreeRequest): asserts request is WorktreeRequest & {
	path: string;
} {
	if (!request.path?.trim()) throw new WorktreeManagerError(`${request.action} requires a worktree path`);
}

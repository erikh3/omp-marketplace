import type { CommandRunner } from "./backends.ts";
import { detectStagingRepositories } from "./bash-policy.ts";

const HINT = [
	"[worktree-manager] You are staging or committing in the repository's main worktree.",
	"For parallel or throwaway work, the worktree_manager tool creates durable Git worktrees",
	"(action: \"create\") so changes stay off the main checkout. Ignore this if the main worktree",
	"is the right place for this change.",
].join(" ");

// Pending map stores the repository hint (resolved later against git state).

/**
 * Observes model-issued `git add`/`commit`/`stage` and, only when the command
 * ran in a repository's primary worktree, returns a one-time passive hint about
 * worktree_manager. Linked worktrees are silent: the agent already isolated its
 * work there. The hint fires at most once per session so it never nags.
 */
export class StageAdvisor {
	private readonly pending = new Map<string, string>();
	private delivered = false;

	constructor(private readonly runner: CommandRunner) {}

	observe(toolCallId: string, command: string, cwd: string): void {
		if (this.delivered) return;
		const [repositoryHint] = detectStagingRepositories(command, cwd);
		if (repositoryHint === undefined) return;
		this.pending.set(toolCallId, repositoryHint);
	}

	async complete(toolCallId: string, isError: boolean): Promise<string | undefined> {
		const repositoryHint = this.pending.get(toolCallId);
		if (repositoryHint === undefined) return undefined;
		this.pending.delete(toolCallId);
		if (isError || this.delivered) return undefined;
		if (!(await this.isPrimaryWorktree(repositoryHint))) return undefined;
		this.delivered = true;
		return HINT;
	}

	clear(): void {
		this.pending.clear();
	}

	/**
	 * True when the hint's directory sits in the repository's main worktree.
	 * Git reports an identical `--git-dir` and `--git-common-dir` only there;
	 * a linked worktree's git-dir lives under `<common>/worktrees/<name>`.
	 */
	private async isPrimaryWorktree(cwd: string): Promise<boolean> {
		try {
			const result = await this.runner.exec("git", ["rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir"], { cwd });
			if (result.code !== 0) return false;
			const [gitDir, commonDir] = result.stdout.trim().split("\n");
			if (!gitDir || !commonDir) return false;
			return gitDir === commonDir;
		} catch {
			return false;
		}
	}
}

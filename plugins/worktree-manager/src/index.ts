import type {
	ExtensionAPI,
	ExtensionContext,
	ToolCallEvent,
} from "@oh-my-pi/pi-coding-agent";
import { isToolCallEventType } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";

import { AdvisoryTracker, relocationReminder } from "./advisory.ts";
import { IncidentStore } from "./incident-store.ts";
import { WorktreeService } from "./worktree-service.ts";
import type { WorktreeServiceResult } from "./worktree-service.ts";
import type { WorktreeAction, WorktreeRequest } from "./validation.ts";

export interface WorktreeManagerOptions {
	incidents?: IncidentStore;
	service?: WorktreeService;
}

function textResult(text: string, isError = false) {
	return { content: [{ type: "text" as const, text }], details: {}, isError };
}

function requestFromParams(params: unknown): WorktreeRequest {
	if (!params || typeof params !== "object" || !("action" in params) || !("repository" in params)) {
		throw new Error("Invalid worktree_manager parameters");
	}
	const { action, repository } = params;
	const branch = "branch" in params ? params.branch : undefined;
	const baseRef = "baseRef" in params ? params.baseRef : undefined;
	const path = "path" in params ? params.path : undefined;
	const gitGlobalArgs = "gitGlobalArgs" in params ? params.gitGlobalArgs : undefined;
	const worktreeArgs = "worktreeArgs" in params ? params.worktreeArgs : undefined;
	if (
		(action !== "create" && action !== "list" && action !== "relocate" && action !== "remove")
		|| typeof repository !== "string"
		|| (branch !== undefined && typeof branch !== "string")
		|| (baseRef !== undefined && typeof baseRef !== "string")
		|| (path !== undefined && typeof path !== "string")
		|| (gitGlobalArgs !== undefined && (!Array.isArray(gitGlobalArgs) || !gitGlobalArgs.every((argument) => typeof argument === "string")))
		|| (worktreeArgs !== undefined && (!Array.isArray(worktreeArgs) || !worktreeArgs.every((argument) => typeof argument === "string")))
	) {
		throw new Error("Invalid worktree_manager parameters");
	}
	return {
		action,
		repository,
		branch,
		baseRef,
		path,
		gitGlobalArgs: gitGlobalArgs ?? [],
		worktreeArgs: worktreeArgs ?? [],
	};
}

function formatResult(result: WorktreeServiceResult): string {
	const header = `Backend: ${result.backend}\nRepository: ${result.repository}`;
	if (result.worktrees) {
		const rows = result.worktrees.map((worktree) => `${worktree.isMain ? "main" : "linked"}\t${worktree.branch ?? "detached"}\t${worktree.path}`);
		return `${header}\nWorktrees:\n${rows.join("\n")}`;
	}
	const details = [
		result.branch ? `Branch: ${result.branch}` : undefined,
		result.path ? `Path: ${result.path}` : undefined,
		result.placement ? `Placement: ${result.placement.expected}` : undefined,
	].filter((line): line is string => line !== undefined);
	return [header, ...details].join("\n");
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function effectiveCwd(event: ToolCallEvent, ctx: ExtensionContext): string {
	if (!isToolCallEventType("bash", event)) return ctx.cwd;
	return typeof event.input.cwd === "string" ? event.input.cwd : ctx.cwd;
}

/** Registers the durable Git worktree tool and non-blocking direct-command advice. */
export default function worktreeManager(pi: ExtensionAPI, options: WorktreeManagerOptions = {}): void {
	const incidents = options.incidents ?? new IncidentStore();
	const service = options.service ?? new WorktreeService({
		exec: (command, args, execOptions) => pi.exec(command, args, execOptions),
	}, incidents);
	const advisory = new AdvisoryTracker(service, incidents);
	const z = pi.zod;

	pi.registerTool({
		name: "worktree_manager",
		label: "Worktree manager",
		description: "Create, list, relocate, or remove durable Git worktrees using the selected placement backend. Do not supply a destination path to create.",
		approval: "write",
		parameters: z.object({
			action: z.enum(["create", "list", "relocate", "remove"]),
			repository: z.string().describe("Git top-level directory"),
			branch: z.string().optional().describe("Required for create"),
			baseRef: z.string().optional().describe("Required for create"),
			path: z.string().optional().describe("Existing worktree path required for relocate and remove"),
			gitGlobalArgs: z.array(z.string()).optional().describe("Ordered Git flags placed before worktree"),
			worktreeArgs: z.array(z.string()).optional().describe("Ordered worktree flags that do not override managed inputs"),
		}),
		async execute(_toolCallId, params, signal) {
			try {
				return textResult(formatResult(await service.execute(requestFromParams(params), signal)));
			} catch (error) {
				return textResult(`worktree_manager: ${message(error)}`, true);
			}
		},
	});

	pi.on("tool_call", async (event, ctx) => {
		if (!isToolCallEventType("bash", event)) return;
		await advisory.observe(event.toolCallId, event.input.command, effectiveCwd(event, ctx), ctx);
	});

	pi.on("tool_result", async (event, ctx) => {
		if (event.toolName !== "bash") return;
		const reminder = await advisory.complete(event.toolCallId, event.isError, ctx);
		if (!reminder) return;
		return { content: [{ type: "text" as const, text: `${reminder}\n\n` }, ...event.content] };
	});

	pi.on("session_start", async (_event, ctx) => {
		try {
			const repository = await service.resolveRepository(ctx.cwd);
			const unresolved = await incidents.list(repository);
			if (unresolved.length === 0) return;
			pi.sendMessage(unresolved.map(relocationReminder).join("\n\n"), { deliverAs: "nextTurn" });
		} catch {
			// The session may start outside a Git repository.
		}
	});

	pi.on("session_shutdown", (_event, ctx) => {
		advisory.clear(ctx);
	});
}

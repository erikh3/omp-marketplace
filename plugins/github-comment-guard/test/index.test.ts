import { describe, expect, mock, test } from "bun:test";
import type { ExtensionAPI, ToolCallEvent } from "@oh-my-pi/pi-coding-agent";

import commentGuard from "../src/index.ts";

type ToolCallHandler = (event: ToolCallEvent) => Promise<unknown>;
type CommandHandler = (args: string, ctx: { ui: { notify: (message: string, level: string) => void } }) => Promise<void>;
function makeApi(
	author: { login: string; type: "Bot" | "User" },
	options: { gateEnabled?: boolean; persistGateState?: boolean } = {},
) {
	const saveGateState = mock(() => {});
	let handler: ToolCallHandler | undefined;
	let commandHandler: CommandHandler | undefined;
	const exec = mock(async (_command: string, args: string[]) => {
		if (args[1]?.includes("/pulls/comments/")) {
			return { code: 0, stdout: JSON.stringify({ user: { login: author.login } }), stderr: "" };
		}
		return { code: 0, stdout: JSON.stringify({ type: author.type }), stderr: "" };
	});
	const pi = {
		exec,
		logger: { debug() {}, info() {}, warn() {} },
		registerCommand(_name: string, command: { handler: CommandHandler }) {
			commandHandler = command.handler;
		},
		on(event: string, callback: ToolCallHandler) {
			if (event === "tool_call") handler = callback;
		},
	} as unknown as ExtensionAPI;
	commentGuard(pi, {
		state: { gateEnabled: options.gateEnabled ?? true },
		persistGateState: options.persistGateState ?? false,
		saveGateState,
	});
	if (!handler) throw new Error("tool_call handler was not registered");
	if (!commandHandler) throw new Error("command handler was not registered");
	return { handler, commandHandler, exec, saveGateState };
}
function event(toolName: string, input: Record<string, unknown>) {
	return { toolName, input } as ToolCallEvent;
}

describe("github-comment-guard", () => {

	test("blocks a human reply using the current MCP schema", async () => {
		const { handler, exec } = makeApi({ login: "octocat", type: "User" });
		const result = await handler(event(
			"mcp__tools_github_mcp__add_reply_to_pull_request_comment",
			{ owner: "owner", repo: "repo", pullNumber: 7, commentId: 42, body: "reply" },
		));

		expect(result).toEqual(expect.objectContaining({ block: true }));
		expect(exec).toHaveBeenCalledTimes(2);
		expect(exec.mock.calls[0]?.[1]?.[1]).toContain("/repos/owner/repo/pulls/comments/42");
	});

	test("uses the enterprise host for MCP author lookup", async () => {
		const { handler, exec } = makeApi({ login: "octocat", type: "User" });
		await handler(event(
			"mcp__tools_github_mcp__add_reply_to_pull_request_comment",
			{ owner: "owner", repo: "repo", pullNumber: 7, commentId: 42, body: "reply" },
		));

		expect(exec.mock.calls[0]?.[1]?.[1]).toStartWith("GH_HOST=github.tools.sap");
	});

	test("allows a bot reply using the current MCP schema", async () => {
		const { handler } = makeApi({ login: "dependabot[bot]", type: "Bot" });
		const result = await handler(event(
			"mcp__tools_github_mcp__add_reply_to_pull_request_comment",
			{ owner: "owner", repo: "repo", pullNumber: 7, commentId: 42, body: "reply" },
		));

		expect(result).toBeUndefined();
	});

	test("allows read-only gh api calls", async () => {
		const { handler, exec } = makeApi({ login: "octocat", type: "User" });
		const result = await handler(event("bash", {
			command: "gh api /repos/owner/repo/pulls/comments/42",
		}));

		expect(result).toBeUndefined();
		expect(exec).not.toHaveBeenCalled();
	});

	test("blocks gh api replies to human review comments", async () => {
		const { handler } = makeApi({ login: "octocat", type: "User" });
		const result = await handler(event("bash", {
			command: "gh api --method POST /repos/owner/repo/pulls/7/comments/42/replies -f body=reply",
		}));

		expect(result).toEqual(expect.objectContaining({ block: true }));
	});

	test("ignores GitHub comment tools that do not create replies", async () => {
		const { handler, exec } = makeApi({ login: "octocat", type: "User" });
		const result = await handler(event("mcp__tools_github_mcp__add_issue_comment", {
			owner: "owner", repo: "repo", issue_number: 7, comment_id: 42, reaction: "+1",
		}));

		expect(result).toBeUndefined();
		expect(exec).not.toHaveBeenCalled();
	});

	test("reports status without changing the gate", async () => {
		const { handler, commandHandler } = makeApi({ login: "octocat", type: "User" });
		const notify = mock(() => {});
		await commandHandler("", { ui: { notify } });

		expect(notify).toHaveBeenCalledWith(
			"github-comment-guard: 🔒 Gate ON. Agent can only reply to bot comments",
			"info",
		);
		const result = await handler(event(
			"mcp__tools_github_mcp__add_reply_to_pull_request_comment",
			{ owner: "owner", repo: "repo", pullNumber: 7, commentId: 42, body: "reply" },
		));
		expect(result).toEqual(expect.objectContaining({ block: true }));
	});

	test("does not persist command changes when persistence is disabled", async () => {
		const { commandHandler, saveGateState } = makeApi(
			{ login: "octocat", type: "User" },
			{ persistGateState: false },
		);
		const notify = mock(() => {});
		await commandHandler("off", { ui: { notify } });

		expect(notify).toHaveBeenCalledWith(
			"github-comment-guard: Gate OFF. Agent can reply to any comment",
			"info",
		);
		expect(saveGateState).not.toHaveBeenCalled();
	});

	test("persists command changes when persistence is enabled", async () => {
		const { commandHandler, saveGateState } = makeApi(
			{ login: "octocat", type: "User" },
			{ persistGateState: true },
		);
		await commandHandler("off", { ui: { notify() {} } });

		expect(saveGateState).toHaveBeenCalledWith({ gateEnabled: false });
	});
});

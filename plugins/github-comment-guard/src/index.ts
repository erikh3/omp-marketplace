/**
 * github-comment-guard: blocks the AI agent from replying to human-authored
 * GitHub comments. Only bot-authored comments (GitHub user type "Bot" or login
 * ending in "[bot]") are replyable by the agent.
 *
 * Gate is on by default. `/github-comment-gate [on|off]` toggles it.
 * State persists to ~/.omp/agent/github-comment-guard.json across sessions.
 */

import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ToolCallEvent,
} from "@oh-my-pi/pi-coding-agent";
import { getAgentDir } from "@oh-my-pi/pi-coding-agent";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// ─── State persistence ────────────────────────────────────────────────────────

interface GateState {
  gateEnabled: boolean;
}

function loadState(): GateState {
  const path = join(getAgentDir(), "github-comment-guard.json");
  if (!existsSync(path)) return { gateEnabled: true };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      !Array.isArray(parsed) &&
      typeof (parsed as Record<string, unknown>)["gateEnabled"] === "boolean"
    ) {
      return { gateEnabled: (parsed as Record<string, unknown>)["gateEnabled"] as boolean };
    }
  } catch {
    // ignore; fall through to default
  }
  return { gateEnabled: true };
}

function saveState(state: GateState): void {
  writeFileSync(
    join(getAgentDir(), "github-comment-guard.json"),
    JSON.stringify(state, null, 2) + "\n",
    "utf8",
  );
}

// ─── GitHub API helpers ───────────────────────────────────────────────────────

/** Resolves the author login of a GitHub issue/PR comment by its ID. */
async function getCommentAuthor(
  pi: ExtensionAPI,
  repo: string,
  commentId: number | string,
  host: string,
): Promise<string | null> {
  try {
    const apiPath = `/repos/${repo}/issues/comments/${commentId}`;
    const ghCmd =
      host !== "github.com"
        ? `GH_HOST=${host} gh api '${apiPath}'`
        : `GH_HOST=github.com gh api '${apiPath}'`;

    const result = await pi.exec("bash", ["-c", ghCmd]);
    if (result.code !== 0) return null;

    const data = JSON.parse(result.stdout) as unknown;
    if (data !== null && typeof data === "object" && !Array.isArray(data)) {
      const user = (data as Record<string, unknown>)["user"];
      if (user !== null && typeof user === "object" && !Array.isArray(user)) {
        const login = (user as Record<string, unknown>)["login"];
        if (typeof login === "string") return login;
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Returns true when the login belongs to a bot account.
 * Uses the GitHub user API; falls back to the [bot] suffix convention.
 * Never blocks on lookup failure — returns false (allow) on any error.
 */
async function isBotLogin(
  pi: ExtensionAPI,
  login: string,
  host: string,
): Promise<boolean> {
  if (login.endsWith("[bot]")) return true;
  try {
    const ghCmd =
      host !== "github.com"
        ? `GH_HOST=${host} gh api '/users/${encodeURIComponent(login)}'`
        : `GH_HOST=github.com gh api '/users/${encodeURIComponent(login)}'`;

    const result = await pi.exec("bash", ["-c", ghCmd]);
    if (result.code !== 0) return false;

    const data = JSON.parse(result.stdout) as unknown;
    return (
      data !== null &&
      typeof data === "object" &&
      !Array.isArray(data) &&
      (data as Record<string, unknown>)["type"] === "Bot"
    );
  } catch {
    return false;
  }
}

// ─── Tool identification ──────────────────────────────────────────────────────

/**
 * MCP tool names that post comments. Both hyphen-separated and
 * underscore-separated variants appear depending on the server registration.
 */
const COMMENT_MCP_TOOLS: Record<string, true> = {
  "mcp__tools-github-mcp__add_issue_comment": true,
  "mcp__tools-github-mcp__add_reply_to_pull_request_comment": true,
  "mcp__tools-github-mcp__add_comment_to_pending_review": true,
  "mcp__tools_github_mcp__add_issue_comment": true,
  "mcp__tools_github_mcp__add_reply_to_pull_request_comment": true,
  "mcp__tools_github_mcp__add_comment_to_pending_review": true,
};

/**
 * Extract reply context from a MCP GitHub comment tool call input.
 * Returns null when the call is not a reply (new top-level comment).
 *
 * add_issue_comment: { owner, repo, issue_number, body, in_reply_to_id? }
 * add_reply_to_pull_request_comment: { owner, repo, pull_number, comment_id, body }
 */
function extractMcpReply(
  input: Record<string, unknown>,
): { repo: string; commentId: number | string; host: string } | null {
  const owner = typeof input["owner"] === "string" ? input["owner"] : null;
  const repo = typeof input["repo"] === "string" ? input["repo"] : null;
  if (!owner || !repo) return null;

  const commentId =
    input["comment_id"] ?? input["in_reply_to_id"] ?? input["in_reply_to"];
  if (commentId === undefined || commentId === null) return null;

  return { repo: `${owner}/${repo}`, commentId: commentId as number | string, host: "github.com" };
}

/**
 * Parse a bash command for GitHub comment-reply patterns.
 * Returns null when the command is not a reply attempt.
 *
 * Handled patterns:
 *   gh pr comment <number> --reply-to <id> ...
 *   gh issue comment <number> --reply-to <id> ...
 *   gh api /repos/<owner>/<repo>/issues/comments/<id>  (POST/PATCH)
 *   GH_HOST=<host> gh ...
 */
function parseBashCommentReply(command: string): {
  repo: string | null;
  commentId: number | string | null;
  host: string;
} | null {
  const hasGhComment = /\bgh\s+(pr|issue)\s+comment\b/.test(command);
  const hasGhApiComment = /\bgh\s+api\b.*\/issues\/comments\/\d+/.test(command);
  if (!hasGhComment && !hasGhApiComment) return null;

  const hostMatch = command.match(/GH_HOST=["']?([^\s"']+)["']?/);
  const host = hostMatch ? hostMatch[1]! : "github.com";

  // --reply-to <id> flag
  const replyToMatch = command.match(/--reply-to\s+(\d+)/);
  if (replyToMatch) {
    const repoMatch = command.match(/(?:-R|--repo)\s+["']?([^\s"']+\/[^\s"']+)["']?/);
    return {
      repo: repoMatch ? repoMatch[1]! : null,
      commentId: parseInt(replyToMatch[1]!, 10),
      host,
    };
  }

  // gh api .../issues/comments/<id>
  const apiMatch = command.match(/\/repos\/([^/]+\/[^/]+)\/issues\/comments\/(\d+)/);
  if (apiMatch) {
    return {
      repo: apiMatch[1]!,
      commentId: parseInt(apiMatch[2]!, 10),
      host,
    };
  }

  // gh pr/issue comment without --reply-to is a new top-level comment; allow.
  return null;
}

// ─── Core gate logic ──────────────────────────────────────────────────────────

async function checkAndBlock(
  pi: ExtensionAPI,
  repo: string | null,
  commentId: number | string | null,
  host: string,
): Promise<{ block: true; reason: string } | undefined> {
  if (repo === null) {
    pi.logger.info("comment-guard: blocked — could not determine repository");
    return {
      block: true,
      reason:
        "comment-guard: could not determine the repository to verify the comment author. Use /comment-gate off to disable the gate.",
    };
  }
  if (commentId === null) {
    pi.logger.info("comment-guard: blocked — could not parse comment ID");
    return {
      block: true,
      reason:
        "github-comment-guard: could not determine the original comment ID to verify the author. Use /github-comment-gate off to disable the gate.",
    };
  }

  const authorLogin = await getCommentAuthor(pi, repo, commentId, host);
  if (authorLogin === null) {
    pi.logger.warn(
      `github-comment-guard: could not resolve comment author for ${repo}#${commentId}; allowing`,
    );
    return undefined;
  }

  const isBot = await isBotLogin(pi, authorLogin, host);
  if (isBot) {
    pi.logger.debug(`github-comment-guard: allowed — @${authorLogin} is a bot`);
    return undefined;
  }

  pi.logger.info(
    `github-comment-guard: blocked reply to human @${authorLogin} on ${repo}#${commentId}`,
  );
  return {
    block: true,
    reason: `github-comment-guard: @${authorLogin} is a human author. The bot-comment-only gate is active. Use /github-comment-gate off to disable.`,
  };
}

// ─── Plugin entry point ───────────────────────────────────────────────────────

export default function commentGuard(pi: ExtensionAPI): void {
  const state = loadState();
  pi.logger.info(`github-comment-guard: loaded, gate=${state.gateEnabled ? "on" : "off"}`);

  // ── /github-comment-gate command ─────────────────────────────────────────

  pi.registerCommand("github-comment-gate", {
    description: "Toggle the bot-comment-only gate. Usage: /github-comment-gate [on|off]",
    handler: async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
      const arg = args.trim().toLowerCase();

      if (arg === "on") {
        state.gateEnabled = true;
      } else if (arg === "off") {
        state.gateEnabled = false;
      } else if (arg === "" || arg === "toggle") {
        state.gateEnabled = !state.gateEnabled;
      } else {
        ctx.ui.notify(
          `github-comment-guard: unknown argument "${args}". Use: /github-comment-gate [on|off]`,
          "error",
        );
        return;
      }

      saveState(state);
      ctx.ui.notify(
        state.gateEnabled
          ? "github-comment-guard: Gate ON — agent can only reply to bot comments"
          : "github-comment-guard: Gate OFF — agent can reply to any comment",
        "info",
      );
      pi.logger.info(`github-comment-guard: gate set to ${state.gateEnabled}`);
    },
  });

  // ── tool_call interceptor ─────────────────────────────────────────────────

  pi.on("tool_call", async (event: ToolCallEvent) => {
    if (!state.gateEnabled) return;

    if (COMMENT_MCP_TOOLS[event.toolName]) {
      const replyInfo = extractMcpReply(event.input as Record<string, unknown>);
      // No reply context = new top-level comment; allow it.
      if (!replyInfo) return;
      return checkAndBlock(pi, replyInfo.repo, replyInfo.commentId, replyInfo.host);
    }

    if (event.toolName === "bash") {
      const command = (event.input as Record<string, unknown>)["command"];
      if (typeof command !== "string") return;
      const replyInfo = parseBashCommentReply(command);
      if (!replyInfo) return;
      return checkAndBlock(pi, replyInfo.repo, replyInfo.commentId, replyInfo.host);
    }
  });
}

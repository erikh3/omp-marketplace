# unslop-pr

TTSR rule that intercepts PR creation and update calls and forces the agent to apply unslop before writing any PR title or description.

## What it does

Two rules fire on different code paths:

- **unslop-pr** — fires when `xd://mcp__tools_github_mcp_create_pull_request` or `xd://mcp__tools_github_mcp_update_pull_request` is written (the `write` tool is the actual carrier for xd:// device calls). Aborts the generation, injects the unslop reminder, and retries.
- **unslop-pr-bash** — fires when the bash tool is called with a command containing `gh pr create`, `gh pr edit`, or `gh pr set`. Same interrupt-and-retry behavior.

## Why two rules

GitHub MCP tools are called via `write(path: "xd://mcp__tools_github_mcp_create_pull_request", ...)`. The tool name seen by the TTSR engine is `write`, not the MCP tool name. A scope like `tool:mcp__tools_github_mcp_create_pull_request` never fires. The correct scope uses `tool:write(*create_pull_request)`, which matches by path basename.

## Install

```
/marketplace install unslop-pr@erikh3-omp-marketplace
```

Takes effect on the next session start.

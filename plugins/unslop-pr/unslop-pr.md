---
name: unslop-pr
condition: [".*"]
scope: "tool:mcp__tools_github_mcp_create_pull_request, tool:mcp__tools_github_mcp_update_pull_request"
interruptMode: always
---

STOP. Before writing any PR title or description:

- If skill://unslop is available, load it and follow its instructions.
- Otherwise apply the rules from memory: no em dashes, no AI vocabulary (leverage, utilize, enhance, delve, pivotal, comprehensive, etc.), no filler phrases, no significance inflation, plain active voice.

Rewrite the title and description, then call the tool again.

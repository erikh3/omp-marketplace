---
name: unslop-pr
condition: [".*"]
scope: "tool:mcp__tools_github_mcp_create_pull_request, tool:mcp__tools_github_mcp_update_pull_request"
interruptMode: always
---

STOP. Load skill://unslop and apply it before writing the PR title and description. If unavailable, apply from memory: no em dashes, no AI vocabulary, no filler, plain active voice. Then retry.

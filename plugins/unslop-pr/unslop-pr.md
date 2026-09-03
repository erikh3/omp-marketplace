---
name: unslop-pr
condition: [".*"]
scope: "tool:mcp__tools_github_mcp_create_pull_request, tool:mcp__tools_github_mcp_update_pull_request"
interruptMode: always
repeatMode: after-gap
repeatGap: 1
---

STOP. Before writing any PR title or description, load skill://unslop and apply it. No em dashes, no AI vocabulary, no filler phrases. Rewrite the content, then call the tool again.

---
name: unslop-pr
condition: [".*"]
scope: "tool:write(*create_pull_request), tool:write(*update_pull_request)"
interruptMode: always
---

STOP. Load skill://unslop and apply it before writing the PR title and description. If unavailable, apply from memory: no em dashes, no AI vocabulary, no filler, plain active voice. Then retry.

---
name: unslop-pr-bash
condition: ["gh pr (create|edit|set)"]
scope: "tool:bash"
interruptMode: always
---

STOP. Load skill://unslop and apply it before writing the PR title and description. If unavailable, apply from memory: no em dashes, no AI vocabulary, no filler, plain active voice. Then retry with the corrected title and body.

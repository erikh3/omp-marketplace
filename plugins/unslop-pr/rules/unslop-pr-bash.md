---
name: unslop-pr-bash
condition: ["gh pr (create|edit|set)"]
scope: "tool:bash"
interruptMode: always
---

Apply skill://unslop before writing the PR title and description. If unavailable, apply from memory: no em dashes, no AI vocabulary, no filler, plain active voice.

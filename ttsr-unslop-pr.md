# TTSR: enforce unslop on PR descriptions

## Problem

The agent consistently skips loading the `unslop` skill before writing PR titles and descriptions, despite AGENTS.md explicitly requiring it. The rule is ignored in practice because it is advisory text in a prompt, not an enforcement mechanism.

## Proposed solution

A TTSR rule at `~/.omp/agent/rules/unslop-pr.md` that intercepts the PR creation and update tool calls mid-stream, aborts the generation, and injects a hard reminder before the retry.

```markdown
---
name: unslop-pr
condition: [".*"]
scope: "tool:mcp__tools_github_mcp_create_pull_request, tool:mcp__tools_github_mcp_update_pull_request"
interruptMode: always
repeatMode: after-gap
repeatGap: 1
---

STOP. Before writing any PR title or description, load skill://unslop and apply it. No em dashes, no AI vocabulary, no filler phrases. Rewrite the content, then call the tool again.
```

## How it works

- `condition: [".*"]` matches anything in the tool argument stream, so fires on every call.
- `scope` limits firing to the two PR tools only.
- `interruptMode: always` aborts the generation every time, no exceptions.
- `repeatMode: after-gap` with `repeatGap: 1` re-arms after each completed turn, so it fires on every PR in a session, not just the first.

## Tradeoff

`condition: [".*"]` fires even when unslop was already run. More precise: match on known AI tells in the body text (e.g. `delve into|leverage|utilize|comprehensive`), but that is fragile and misses new patterns. The blunt approach is safer.

## Status

File not yet created. User confirmed intent but has not given final go-ahead.

## Action

Write the file:

```
~/.omp/agent/rules/unslop-pr.md
```

Takes effect on the next omp session start (no restart needed).

# unslop-pr

TTSR rule that intercepts `create_pull_request` and `update_pull_request` tool calls and forces the agent to load the `unslop` skill before writing PR titles or descriptions.

## How it works

`interruptMode: always` aborts the tool call mid-stream. `repeatMode: after-gap` with `repeatGap: 1` re-arms after each completed turn, so the rule fires on every PR in the session, not just the first.

## Install

Copy `unslop-pr.md` to `~/.omp/agent/rules/unslop-pr.md`. Takes effect on the next session start.

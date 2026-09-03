# unslop-pr

TTSR rule that intercepts `create_pull_request` and `update_pull_request` tool calls and forces the agent to load the `unslop` skill before writing PR titles or descriptions.

## How it works

`interruptMode: always` aborts the tool call mid-stream. Fires once per session (default `repeatMode: once`).

## Install

```
/marketplace install unslop-pr@<your-marketplace>
```

Or manually copy `rules/unslop-pr.md` to `~/.omp/agent/rules/unslop-pr.md`. Takes effect on the next session start.

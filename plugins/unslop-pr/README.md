# unslop-pr

An always-applied prompt rule that asks the agent to apply `skill://unslop` before creating a PR or changing its title or description.

## What it does

The instruction covers GitHub MCP calls and `gh` commands without intercepting either tool path. Updates that do not change the title or description need no wording review.

This is guidance, not a content validator. It does not abort generation, retry tool calls, or claim that compliant text violates a rule. If the skill is unavailable, the instruction supplies basic plain-writing guidance.

## Install

```
/marketplace install unslop-pr@erikh3-omp-marketplace
```

Takes effect on the next session start.

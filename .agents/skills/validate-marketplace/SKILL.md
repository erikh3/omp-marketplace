---
name: validate-marketplace
description: Validate this repository after changing the marketplace catalog or installed plugin content and before committing.
user-invocable: true
allowed-tools:
  - Bash(bun scripts/validate-marketplace.ts)
---

# Validate marketplace

Run the repository validator from the repository root:

```bash
bun scripts/validate-marketplace.ts
```

Fix every reported error and rerun until it succeeds. This validates catalog and manifest invariants only. It does not replace plugin tests, type checking, or an OMP runtime smoke test required by `AGENTS.md`.

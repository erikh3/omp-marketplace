# worktree-manager

OMP extension for model-initiated durable Git worktrees. It registers one tool:

```text
worktree_manager
```

Use it for `create`, `list`, `relocate`, and `remove`. The tool owns destination selection. `create` takes a Git top-level directory, branch, and base ref. It does not accept a destination path.

## Placement backends

Every backend manages Git worktrees. Backend selection is automatic:

- `HERDR_ENV=1`: Herdr creates the worktree and owns its location.
- Otherwise: Git creates it at `<repository>/.omp/worktrees/<branch>`.

The Git backend accepts ordered `gitGlobalArgs` and `worktreeArgs`. It keeps supported flags in their original command positions. It rejects only values that would replace the repository, operation, branch, base ref, or managed destination.

`list` reports every worktree registered by Git for the repository, including worktrees this plugin did not create. The Git backend removes only worktrees under its managed root. `relocate` moves a linked branch worktree into that root.

The installed Herdr CLI has no worktree relocation command. Under Herdr, create a replacement through the tool and migrate changes before removing the old Herdr workspace.

## Direct Git commands

The extension observes model-issued Bash calls for direct `git worktree add` and `git worktree move` commands. It never blocks, rewrites, or intercepts a user `!` command.

When an absolute destination violates the active backend policy, the Bash result receives a reminder. The plugin writes the unresolved incident to:

```text
~/.omp/agent/worktree-manager-incidents.json
```

The next OMP session in that repository receives a `nextTurn` reminder until `worktree_manager` relocates or removes the worktree. No session replay, rewind, or history mutation is supported.

OMP task isolation and pull-request checkout remain separate temporary checkout features. This plugin does not replace or block either path.

## Install

```text
/marketplace install worktree-manager@erikh3-omp-marketplace
```

Restart OMP after installation. Extension modules load at process start.

## Development

Link the local package, then restart OMP after every edit:

```bash
omp plugin link ./plugins/worktree-manager
```

Run tests and type checking from the plugin directory:

```bash
bun test --isolate
bun run typecheck
```

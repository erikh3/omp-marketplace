# worktree-manager

OMP extension for model-initiated durable Git worktrees. It registers one tool:

```text
worktree_manager
```

Use it for `create`, `list`, and `remove`. The tool owns destination selection. `create` takes a Git top-level directory, branch, and base ref. It does not accept a destination path.

## Dirty-main cutover

Before `create`, the tool checks the main checkout for staged, unstaged, and untracked changes, even when the request originates in a linked worktree. If main is dirty, the successful result includes a cutover reminder. A clean main checkout receives no reminder.

Creation does not transfer edits, change the session directory, or clean main. Before continuing task work, transfer and verify only the task's changes in the new worktree, then undo those changes in main. Preserve user and other-task changes. Main must return to its pre-task status and staged and unstaged diffs, not necessarily to a clean state. Do not use whole-worktree cleanup commands. If ownership is uncertain, stop cleanup and ask the user.

If the main-checkout status check fails, creation does not proceed.

## Placement backends

Every backend manages Git worktrees. Backend selection is automatic:

- `HERDR_ENV=1`: Herdr creates the worktree and owns its location.
- Otherwise: Git creates it at `<repository>/.omp/worktrees/<branch>`.

The Git backend accepts ordered `gitGlobalArgs` and `worktreeArgs`. It keeps supported flags in their original command positions. It rejects only values that would replace the repository, operation, branch, base ref, or managed destination.

The Herdr backend maps `--trust-repository` to its create and remove commands. For remove, it also maps `--force` to `herdr worktree remove`; it does not pass `--force` to the preceding workspace lookup.

`list` returns concise locations for non-main, non-prunable worktrees. `remove` accepts any linked worktree in the repository, except the main worktree. Remove an incorrectly placed worktree, then create it through the tool again.

## Direct Git commands

The extension observes model-issued Bash calls for direct `git worktree add` and `git worktree move` commands. It never blocks, rewrites, or intercepts a user `!` command.

When an absolute destination violates the active backend policy, the Bash result receives a reminder. The plugin writes the unresolved incident to:

```text
~/.omp/agent/worktree-manager-incidents.json
```

The next OMP session in that repository receives a `nextTurn` reminder until `worktree_manager` removes the worktree. No session replay, rewind, or history mutation is supported.

OMP task isolation and pull-request checkout remain separate temporary checkout features. This plugin does not replace or block either path.

## Main-worktree staging hint

When the model runs `git add`, `git commit`, or `git stage` in a repository's
**primary** worktree, the Bash result carries a one-time passive note that
`worktree_manager` can create a durable worktree for isolated work. It is a
hint, not a block: the command always runs, and the note is attached as
separate developer context rather than mixed into the command output.

The hint stays quiet when it is not useful:

- It never fires inside a linked worktree. The plugin compares `git rev-parse
  --git-dir` with `--git-common-dir`; they match only in the main worktree, so
  work already isolated in a dedicated worktree gets no reminder.
- It fires at most once per session.
- It is skipped when the staging command itself failed.

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

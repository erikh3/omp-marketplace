# git-commit-linter

OMP extension that validates model-issued `git commit` messages against
commitlint rules before Bash executes.

## Scope

This plugin intercepts only Bash `tool_call` events where the model issues a
`git commit` command. It does not intercept:

- `!git commit` user bang commands
- commits made in a terminal session
- commits produced by `git merge`, `git rebase`, or `git cherry-pick`
- `git ci` or any other alias

Only a literal `commit` subcommand triggers validation. Everything else passes
through untouched.

## Supported command forms

The parser accepts statically resolvable commands. These all work:

```bash
git commit -m "feat: add widget"

git commit --message "fix: correct off-by-one"

# Multiline message via repeated -m (joined with double newline)
git commit -m "feat: add widget" -m "Closes #42"

# Compound commands — every commit in the chain validates
git add . && git commit -m "feat: add widget"

# Git -C to set worktree
git -C /path/to/repo commit -m "feat: add widget"

# File-based message (file must exist before Bash starts)
git commit -F commit-msg.txt

# Reuse a previous commit message
git commit -C HEAD

# Attached and equals-separated flag forms
git commit -m"feat: add widget"
git commit --message="feat: add widget"

# Leading environment assignments
GIT_AUTHOR_NAME="Bot" git commit -m "feat: add widget"

# env prefix
env GIT_AUTHOR_NAME="Bot" git commit -m "feat: add widget"

# Git global options before commit
git --no-pager commit -m "feat: add widget"
git --git-dir=.git commit -m "feat: add widget"
```

## Skipped forms (no validation)

These forms are explicitly allowed to execute without lint checks:

```bash
# Amend without touching the message
git commit --amend --no-edit

# Fixup and squash commits (Git generates the message)
git commit --fixup=HEAD
git commit --squash=abc1234
```

## Blocked forms

The parser blocks commands it cannot resolve statically rather than guessing.
Each blocked call produces a reason code and explanation:

```bash
# Dynamic message
git commit -m "$MY_MSG"

# Expansion in the worktree path
git commit -C "$(git rev-parse HEAD)"

# File created by an earlier command in the same Bash call
echo "feat: add" > /tmp/msg && git commit -F /tmp/msg

# stdin-fed message
echo "feat: add" | git commit -F -

# Heredoc input
git commit -F - <<EOF
feat: add
EOF

# Nested under eval or bash -c
bash -c "git commit -m 'feat: add'"
eval "git commit -m 'feat: add'"

# Dynamic cd affecting a commit
cd "$(get_dir)" && git commit -m "feat: add"

# Editor-bound commit (no static message)
git commit

# core.commentChar=auto with a cleanup mode that depends on it
# (blocks as unresolved)
```

## Default policy

With no repository commitlint config present, the plugin enforces
[Conventional Commits](https://www.conventionalcommits.org/) via
`@commitlint/config-conventional`.

### Valid and invalid commit messages

The bundled policy follows Conventional Commits. A valid header has a recognized
lowercase type, an optional scope, a colon, and a non-empty subject.

| Message | Result | Reason |
|---|---|---|
| `feat: add user login` | Valid | Recognized type and non-empty subject |
| `fix(auth): correct token expiry` | Valid | Optional lowercase scope |
| `chore!: drop Node 16 support` | Valid | Breaking-change marker after the type |
| `feat(api)!: remove legacy endpoint` | Valid | Scope and breaking-change marker |
| `add user login` | Invalid | Missing type and colon |
| `feature: add user login` | Invalid | `feature` is not an allowed type |
| `FEAT: add user login` | Invalid | Type must be lowercase |
| `fix:` | Invalid | Subject is empty |
| `fix: Correct token expiry` | Invalid | Subject starts in sentence case |
| `fix: correct token expiry.` | Invalid | Subject ends with a full stop |

Examples as complete commands:

```bash
# accepted
git commit -m "feat: add user login"
git commit -m "fix(auth): correct token expiry"
git commit -m "feat!: remove legacy login"

# blocked by commitlint
git commit -m "add user login"
git commit -m "feature: add user login"
git commit -m "fix:"
```

Repository commitlint configuration can change these results. For example, a
repository may allow extra types, require a ticket-shaped scope, or use different
subject rules.

## Repository commitlint config

When a repository has its own commitlint config (`commitlint.config.js`,
`.commitlintrc.json`, `.commitlintrc.yml`, `commitlint` in `package.json`, or
the other standard locations), that config fully replaces the plugin's default
policy for commits in that repository. Standard JS, TS, JSON, YAML, and
`package.json` discovery applies.

If the repository config exists but cannot be loaded (parse error, missing
extends, invalid rule), linting is skipped for that Bash call. The commit
executes, and a warning is injected into the tool result:

```
Warning: commit linting was skipped for this call.
The repository commitlint config at /path/to/repo could not be loaded, so no
message validation ran. The commit may have already executed.
Config error: <error detail>
Fix the repository config to restore linting.
```

This is intentional fail-open behavior. Fix the repository config to restore
linting.

## Plugin JSONC config

The plugin reads two JSONC files on every attempt:

1. `~/.omp/agent/git-commit-linter.jsonc` (user-level, lower precedence)
2. `<git-root>/.omp/git-commit-linter.jsonc` (project-level, higher precedence)

Either or both files may be absent. JSONC comments and trailing commas are
supported.

Example config:

```jsonc
{
  // Standard commitlint fields are supported.
  "extends": ["@commitlint/config-conventional"],
  "rules": {
    "scope-enum": [2, "always", ["api", "ui", "infra"]],
    "body-max-line-length": [1, "always", 100]
  },
  "defaultIgnores": true,
  "helpUrl": "https://example.com/commits",

  // Plugin behavior section. Currently accepts no keys.
  "gitCommitLinter": {}
}
```

Project values override user values for matching rule names. Other arrays
replace rather than merge.

### Serializable fields only

Because JSONC cannot contain executable code, these shapes are not accepted in
plugin config files and fail closed:

- function-valued `ignores` arrays
- inline plugin objects (use string package names instead)
- async rule factories
- any other executable JavaScript

A repository JS/TS commitlint config may use all of those because
`@commitlint/load` resolves it normally.

A malformed or unloadable plugin JSONC config is a fatal error and blocks the
entire Bash call.

## Cleanup behavior

Before linting, the plugin applies the same cleanup Git would apply to the
message:

1. Explicit `--cleanup` flag on the command line
2. Repository `commit.cleanup` config
3. Default: `whitespace` for inline `-m`, `-F`, and `-C` sources

`core.commentChar` is read from the repository. Absent means `#`. If it is set
to `auto` and the active cleanup mode depends on recognizing comment lines, the
command blocks as unresolved.

## No runtime bypass

There is no command to disable enforcement at runtime. To stop linting a
specific repository, add a commitlint config that allows the messages you need,
or remove the plugin. Changing enforcement requires a config or plugin change,
not a session command.

## Install

```
/marketplace install git-commit-linter@erikh3-omp-marketplace
```

Restart OMP after installing. Extension modules load at startup.

## Development

Link the working directory so edits take effect immediately:

```bash
omp plugin link ./plugins/git-commit-linter
```

Restart OMP after linking, and after each edit.

Run tests:

```bash
cd plugins/git-commit-linter
bun test --isolate
```

Type-check:

```bash
bun run typecheck
```

## Known boundaries

- Git aliases (`git ci`, etc.) are never intercepted, only literal `git commit`.
- Commits produced by merge, rebase, cherry-pick, or revert are not validated.
- No automatic message correction. Block means block.
- No Git hook installation.
- No TTSR rules or `user_bash` handler.

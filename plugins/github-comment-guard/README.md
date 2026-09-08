# github-comment-guard

Blocks omp from replying to GitHub comments written by people. Replies to bot comments remain allowed.

The guard runs before a tool call. New top-level comments are not blocked.

## Supported calls

The plugin inspects `add_reply_to_pull_request_comment`. Tool names registered with either hyphens or underscores are recognized.

It also inspects Bash calls that post a pull request review comment reply through the GitHub API:

```sh
gh api --method POST /repos/<owner>/<repo>/pulls/<pull-number>/comments/<comment-id>/replies -f body=<text>
```

Read-only `gh api` calls and new top-level comments are not blocked.

## Author lookup

For a reply, the plugin uses `gh api` to read the original comment and its author. An account counts as a bot when either condition is true:

- GitHub reports its user type as `Bot`.
- Its login ends with `[bot]`.

Bare `gh` commands use `github.com`. Commands prefixed with `GH_HOST=<host>` use that host.

If the plugin cannot resolve the original comment author, it allows the tool call and writes a warning to the omp log. If it cannot determine the repository or comment ID, it blocks the call because it cannot check the author.

## Configuration

The guard is enabled by default. Its state is stored at:

```text
~/.omp/agent/github-comment-guard.json
```

Use the command to inspect or change it:

```text
/github-comment-gate
/github-comment-gate on
/github-comment-gate off
```

Calling `/github-comment-gate` without an argument reports the current state.

Set `persistGateState` in the plugin settings to control whether changes survive a restart. It defaults to `true`.

```sh
omp plugin config github-comment-guard set persistGateState false
```

When disabled, every new session starts with the gate on. The slash command only changes the current session.

## Installation

Install from the marketplace:

```text
/marketplace install github-comment-guard@erikh3-omp-marketplace
```

Restart omp after installation so it loads the extension.

For local development:

```sh
bun install
bun run typecheck
omp plugin link ./plugins/github-comment-guard
```

## Limits

The guard only sees tool calls made through the supported MCP tools or recognized Bash command forms. Other GitHub clients, unrecognized command syntax, and direct HTTP requests are outside its scope.

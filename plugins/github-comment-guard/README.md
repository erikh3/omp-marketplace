# github-comment-guard

Blocks omp from replying to GitHub comments written by people. Replies to bot comments remain allowed.

The guard runs before a tool call. New top-level comments are not blocked.

## Supported calls

The plugin inspects these GitHub MCP tools:

- `add_reply_to_pull_request_comment`
- `add_issue_comment` when the input identifies a parent comment
- `add_comment_to_pending_review` when the input identifies a parent comment

It also inspects Bash calls that match either of these forms:

```sh
gh pr comment <number> --reply-to <comment-id>
gh issue comment <number> --reply-to <comment-id>
gh api /repos/<owner>/<repo>/issues/comments/<comment-id>
```

Tool names registered with either hyphens or underscores are recognized.

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

Use the command below to change it:

```text
/github-comment-gate on
/github-comment-gate off
/github-comment-gate
```

Calling `/github-comment-gate` without an argument toggles the current state.

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

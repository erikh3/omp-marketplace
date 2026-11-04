# github-comment-guard

Blocks omp from creating or submitting pull request reviews and from replying to GitHub comments written by people. Replies to bot comments remain allowed.

The guard runs before a tool call. New top-level issue comments are not blocked.

## Supported calls

The plugin blocks `add_comment_to_pending_review` and the `create` and `submit_pending` methods of `pull_request_review_write`. Cleanup operations such as `delete_pending`, `resolve_thread`, and `unresolve_thread` remain allowed. Tool names registered with either hyphens or underscores are recognized.

It also inspects `add_reply_to_pull_request_comment` and checks the original comment's author before allowing the reply.

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
/github-comment-gate status
/github-comment-gate on
/github-comment-gate off
```

Calling `/github-comment-gate` without an argument toggles the gate. Turning it on shows a compact notice and a status card. Turning it off shows only a shield-marked `GitHub gate off.` notice.

Use `/github-comment-gate status` to inspect the gate without changing it. The three-row card groups review and human-reply permissions, bot and top-level comment permissions, and shows `persistent` or `session-only` beside the state. It retains OMP's custom-message background, body colors, and muted border. ON, Allowed, and their icons are green; OFF and its shield are amber; Blocked and its icon are muted. Toggle notices use the same state colors.

Shield, blocked, and allowed icons follow OMP's active symbol preset: Nerd Font, Unicode, or ASCII. Text labels keep the meaning readable without color.

Explicit `on` and `off` commands set the state without toggling and show a compact notice. Argument completion suggests `on`, `off`, and `status` after a typed prefix. Bare command completion leaves the toggle intact.

During agent work, the command changes the gate immediately, but OMP queues its transcript messages until the next response or tool boundary. These messages enter model context and can cause an extra model step. Display timing does not postpone enforcement for subsequent tool calls.

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
bun test
bun run typecheck
omp plugin link ./plugins/github-comment-guard
```

## Limits

The guard only sees tool calls made through the supported MCP tools or recognized Bash command forms. Other GitHub clients, unrecognized command syntax, and direct HTTP requests are outside its scope.

## Changes in 0.2.0

- Bare `/github-comment-gate` now toggles instead of reporting status. Use `/github-comment-gate status` for a read-only check.
- Add a status card, compact state notices, and argument completion, matching the speech notification command UI.

## Changes in 0.2.1

- Replace the generic message header and verbose status rows with a three-row, icon-based card.
- Use theme colors and symbol presets for the card and compact toggle notices.

## Changes in 0.2.2

- Restore the custom-message card colors and padding while retaining compact text and themed icons.
- Keep colored toggle notices and document OMP's deferred message delivery during agent work.

## Changes in 0.2.3

- Color state headings, permission labels, and their icons consistently with the toggle notices.
- Retain the custom-message background, neutral descriptions, and muted border.

## Changes in 0.2.4

- Mute the Blocked label and icon while preserving the green ON/Allowed and amber OFF colors.

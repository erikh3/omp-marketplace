# Speak notifications

Deliberate local speech notifications for the primary OMP agent. Requires OMP 18.16.0 or a compatible version. Notifications start off in every new or resumed session. No plugin settings, skill, or configuration is required.

```text
/speak
/speak on
/speak status
/speak off
```

`/speak` toggles notifications. Enabling immediately prints full status; disabling shows only `Speech notifications off.` `/speak on` and `/speak off` set the state explicitly; `/speak status` shows it without changing it. Disabling clears waiting messages and stops owned synthesis and playback. Argument completion suggests `on`, `off`, and `status` after you type a prefix, such as `/speak o` or `/speak s`. Empty arguments show no suggestions so Enter still toggles.

Startup state is communicated to the agent without a visible chip. State changes show `Speech notifications on.` or `Speech notifications off.` Subagents do not receive the tool or its guidance.

## Notification policy

When enabled, only the primary agent writes and requests speech. It chooses the wording, frequency, and trigger point. The tool accepts only text and purpose:

```text
speak_notification({ text: "The deployment is blocked by an expired credential.", purpose: "attention" })
```

Use `outcome` for a substantial task result, including a negative or inconclusive result. Use `attention` before waiting for material user action, such as a decision, approval, authentication, or blocker removal. Use `milestone` only for meaningful new progress that does not replace the final outcome.

Do not announce routine progress, reads, edits, intermediate tests, recoverable errors, logs, code, quick answers, or unchanged status. Combine related results. A milestone does not replace a final outcome. The plugin does not classify work, read transcripts or final answers, supply fixed spoken phrases, create timer prompts, wake the agent, intercept calls, block user actions, or make additional model turns.

The tool description contains the stable policy. Each primary-agent request receives a compact live-state note ahead of existing messages. The note is metadata, not a user request. It does not contain notification history or create a follow-up request.

The plugin suppresses the same trimmed, whitespace-normalized text within a user task. It remembers at most 32 texts. Starting a new task clears that text memory. Disabling notifications or resuming a session resets all notification memory. A suppressed call returns a non-error result with `accepted: false`, `suppressed: true`, and a message that says not to retry. Do not retry suppressed calls. Invalid text and a full queue remain errors and do not consume suppression state.

Accepted `milestone` speech is limited to one per five minutes measured from any accepted speech. `outcome` and `attention` speech bypass that limit. Queue acceptance, not playback completion, makes speech accepted. The plugin does not consume a milestone interval or remember text when it rejects a call.

## Playback and limits

A single FIFO worker runs `omp say` without overlapping plugin playback. It passes the parent session's resolved local speech model, voice, and speed explicitly. Cloud TTS and OMP automatic vocalization are unchanged.

Three messages may wait, excluding active playback. A successful tool call returns immediately with waiting-only position and depth, not a playback-success claim. Excess messages are rejected. Enabled calls reject blank text, Unicode control characters, and trimmed text over 500 Unicode code points.

First playback may download the local model. `/speak on` does not guarantee synthesis readiness. Failures are shown immediately and retained in `/speak status` until successful playback clears them. Disabling notifications does not clear a prior error.

Status separates notification state, playback, and waiting queue from the local model, voice, and speed. It shows a playback error only when one is retained.

## Installation

```sh
omp plugin install speak-notifications@erikh3-omp-marketplace
```

Restart OMP after installing. Enable notifications separately in each session.

## Development

```sh
bun install --frozen-lockfile
bun test --isolate
bun run typecheck
```

From the marketplace root:

```sh
omp plugin link ./plugins/speak-notifications
bun scripts/validate-marketplace.ts
```

Restart OMP, exercise disabled calls, enable and queue messages, then turn notifications off during synthesis and playback. Verify that subagents cannot see the tool and a resumed session starts disabled. See the [plugin specification](../../docs/specs/speak-notifications-specification.md) for the complete contract.

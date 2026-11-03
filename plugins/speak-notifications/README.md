# Speak notifications

Deliberate local speech notifications for the primary OMP agent. Requires OMP 18.16.0 or a compatible version. Notifications start off in every new or resumed session. No plugin settings, skill, or configuration is required.

```text
/speak on
/speak status
/speak off
```

`/speak on` enables notifications for this session. `/speak off` clears waiting messages and stops owned synthesis and playback. Startup state is communicated to the agent without a visible chip. Toggles show only `Speech notifications on.` or `Speech notifications off.`; full state instructions stay hidden in model context. Subagents do not receive the tool or its guidance.

When enabled, the primary agent must announce blockers, decision requests, completed or failed long-running operations, and substantial task outcomes without another speech request. It chooses a short message itself. Brief meaningful phase updates are allowed; routine tool progress, greetings, logs, code, and repeated status remain text-only. Related outcomes are combined and events are not announced twice.

## Playback and limits

A single FIFO worker runs `omp say` without overlapping plugin playback. It passes the parent session's resolved local speech model, voice, and speed explicitly. Cloud TTS and OMP automatic vocalization are unchanged.

Three messages may wait, excluding active playback. An accepted tool call returns immediately with its waiting-only position and depth, not a playback-success claim. Excess messages are rejected. Enabled calls reject blank text, Unicode control characters, and trimmed text over 500 Unicode code points. Disabled calls return the disabled notice without queueing.

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

Restart OMP, exercise disabled calls, enable and queue messages, then turn notifications off during synthesis and playback. Verify that subagents cannot see the tool and a resumed session starts disabled. See the repository's `speak-notifications.md` for the complete contract.

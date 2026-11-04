# Speak notifications

Deliberate local speech notifications for the primary OMP agent. Requires OMP 18.16.0 or a compatible version. Notifications start off in every new or resumed session. No plugin settings, skill, or configuration is required.

```text
/speak
/speak on
/speak status
/speak off
```

`/speak` toggles notifications. Enabling immediately prints full status; disabling shows only `Speech notifications off.` `/speak on` and `/speak off` set the state explicitly; `/speak status` shows it without changing it. Disabling clears waiting messages and stops owned synthesis and playback. Argument completion suggests `on`, `off`, and `status` after you type a prefix, such as `/speak o` or `/speak s`. Empty arguments show no suggestions so Enter still toggles.

Startup state is communicated to the agent without a visible chip. State changes show `Speech notifications on.` or `Speech notifications off.`; a bare toggle that enables notifications also shows full status below it. Full state instructions stay hidden in model context. Subagents do not receive the tool or its guidance.

When enabled, the primary agent must announce substantial task outcomes and blockers or decisions needing user attention. Implementation, debugging, multi-source research, reviews, and long operations normally qualify, including negative or inconclusive outcomes. Quick answers and routine commands normally stay silent. The agent judges significance and wording; related outcomes and child results are combined. A milestone does not replace the final outcome. Routine progress, recoverable errors, greetings, logs, code, and repeated status stay text-only.

The plugin supplies current enabled state before each model request so restored notices cannot override it. After work qualifies as a candidate substantial task, the next existing model request receives one optional completion assessment before the final answer. Candidates have a successful file edit/write, at least three work calls, or at least one work call in a task lasting a minute. These select when to ask the agent to judge, not when to force speech. Earlier notifications do not suppress this assessment: the agent can skip speech if the final outcome was already announced. The assessment never starts a post-answer turn, so declining it cannot trigger empty-response retries. Ordinary empty-response recovery remains unchanged.

## Silence reminder

Enabling starts a five-minute cooldown. Queued speech pauses it through synthesis and playback. A successful playback completion resets it to five minutes; enqueue acceptance alone does not count as successful speech. Failures preserve the last-success time but defer another reminder for five minutes.

At expiry, one hidden reminder becomes pending for the next model request, stating how long speech has been silent. A running tool finishes uninterrupted. The agent may announce a meaningful milestone or continue silently. The reminder does not force speech or block urgent notifications. Reminders repeat at most once per five minutes while working. An idle session retains one pending reminder without waking the model. Turning speech off resets and freezes the timer and discards pending reminders. Resume and shutdown also clear it. Explicit user requests for silence take precedence.

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

Restart OMP, exercise disabled calls, enable and queue messages, then turn notifications off during synthesis and playback. Verify that subagents cannot see the tool and a resumed session starts disabled. See the [plugin specification](../../docs/specs/speak-notifications-specification.md) for the complete contract.

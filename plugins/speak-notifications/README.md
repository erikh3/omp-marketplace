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

When enabled, the primary agent must announce substantial task outcomes and material blockers or decisions needing user attention. Implementation, debugging, multi-source research, reviews, and long operations normally qualify, including negative or inconclusive outcomes. Quick answers and routine commands normally stay silent. The agent judges significance and wording; related outcomes and child results are combined. A milestone does not replace the final outcome. Routine progress, intermediate tests, recoverable errors, greetings, logs, code, and unchanged status stay text-only. Speech must execute before a blocking question, not after the question in the same batch. Queued speech counts as pending coverage and must not be duplicated.

The stable policy is the essential `speak_notification` tool description, so the primary agent receives it with the registered schema on every model request. Current enabled state, checkpoint IDs, and timer reminders remain one short transient instruction. That instruction is session metadata, not a task or request. The agent answers the user, not the metadata. No notification history or repeated full-policy custom message is copied into context. After the first enabled work result, the current task exposes an optional outcome identifier. It is valid only for purpose `outcome` and a substantial result. Candidate thresholds still determine whether the plugin requests a missing decision or recovery. Candidates have a successful file edit/write, at least three work calls, or at least one work call in a task lasting a minute. Returned background results receive a targeted assessment. Related assessment and timer reminders combine into one instruction. Attention uses an exact active-tool boundary until the plugin requests an attention identifier. The agent records an explicit speak-or-silent decision with purpose outcome, attention, or milestone. Earlier progress decisions do not satisfy final-outcome decisions.

Outcome decisions use the current outcome identifier shown in request context. Attention decisions use either an attention identifier supplied by the plugin or an exact boundary target, never an outcome identifier. A tool target includes the active tool name and its complete execution arguments, except OMP's top-level `i` intent metadata. A plan-review target binds the normalized plan path and current file contents. A changed target creates an uncovered boundary. Stale identifiers, inactive tools, unreadable plans, invalid text, and purpose-mismatched identifiers do not queue audio or satisfy a checkpoint. A valid repeated resolved identifier is idempotent.

If a candidate task finishes without an outcome decision, one bounded follow-up requests it. OMP delivers that recovery as hidden next-turn context. Before an `ask` or the installed Plannotator review or annotation action without an attention decision, the plugin blocks that operation once and requests a decision before resubmission. OMP emits a preflight execution event for that blocked call. It does not make the decision unresolved. The next model request has one chance to record a decision before a later omitted decision becomes text-only unresolved status. The normal prompt and task result remain available. Approval and native plan-review events occur too late for a safe model turn. The plugin leaves their host prompts available and records uncovered waits as unresolved.

Blocked nested `xd://` transports preserve their inner attention checkpoint until the actual boundary executes. Consumed unresolved boundaries release active capacity while retaining the task's unresolved count. Host-owned automatic abort retries preserve current task decisions; a new user task clears prior background-result candidate state.

The 0.4.0 tool contract replaces text-only calls:

```text
speak_notification({ action: "speak", purpose: "outcome", checkpointId: "speech-…", text: "Deployment is blocked by expired credential handling." })
speak_notification({ action: "silent", purpose: "attention", boundary: { kind: "tool", toolName: "ask", input: { questions: [{ id: "format", question: "Choose the report format.", options: [{ label: "Text" }, { label: "JSON" }] }] } }, reason: "The routine format choice does not need audio." })
```

The checkpoint identifier requests a decision, not audio. Choose a meaningful final outcome before finishing. Do not speak merely because an identifier is present. Timer reminders remain advisory. The plugin does not change ordinary empty-response recovery.
## Silence reminder

The five-minute countdown measures active work while notifications are enabled. Model requests, thinking, foreground tools, and running background jobs count. Idle time with no running jobs pauses the remaining interval. Waiting for a user answer, tool approval, or plan review also pauses it, even when background jobs run. Queued speech pauses it through synthesis and playback. Successful playback resets the interval; enqueue acceptance alone does not count as success. Failures preserve elapsed active silence but defer the next assessment for five more active minutes.

Expiry retains one pending assessment until the next model request. It does not interrupt work or wake an idle agent. The agent may announce useful new information or continue silently. Optional milestones normally occur at most once per five minutes; final outcomes and urgent actions do not wait. Timer reminders repeat at most once per five active minutes and never require invented progress. Turning speech off resets and freezes the timer and clears pending reminders. Resume and shutdown also clear it. Explicit user requests for silence take precedence.

An expired timer assessment takes precedence over optional outcome metadata, but required outcome decisions take precedence over the timer. Context inspection does not consume a reminder. Consumption occurs only after an active model turn receives its timer instruction.

## Playback and limits

A single FIFO worker runs `omp say` without overlapping plugin playback. It passes the parent session's resolved local speech model, voice, and speed explicitly. Cloud TTS and OMP automatic vocalization are unchanged.

Three messages may wait, excluding active playback. A speak decision returns immediately with waiting-only position and depth, not a playback-success claim. Excess messages are rejected. Enabled speak decisions reject blank text, Unicode control characters, and trimmed text over 500 Unicode code points. Silent decisions require a short reason and never queue speech. Disabled decisions return the disabled notice without queueing or satisfying an enabled decision boundary.

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

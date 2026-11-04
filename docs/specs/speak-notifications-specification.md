# Speak Notifications plugin specification

The next implementation session must follow [Speech notification checkpoints: specification and implementation plan](speech-notification-checkpoints-plan.md). It supersedes the decision bookkeeping, recovery, and enforcement sections below. Check live speech enablement first. Use OMP-level checkpoints without provider-specific forcing.

## Purpose

Add a self-contained personal OMP plugin named `speak-notifications`. It gives agents deliberate, short text-to-speech notifications without enabling OMP's automatic assistant vocalization.

The plugin must be installable from this marketplace without a skill, `AGENTS.md` rule, or separate OMP configuration. Notifications start disabled in every session. The user enables them with `/speak on`.

## User interface

### Commands

| Command | Behavior |
| --- | --- |
| `/speak` | Toggle the current session state using the same enable or disable behavior below. When enabling, immediately show full status. When disabling, show only the off notice. |
| `/speak on` | Enable deliberate speech notifications for the current session. Append a visible, agent-visible system notice. |
| `/speak off` | Disable notifications for the current session. Clear queued notifications and stop owned synthesis and playback processes. Append a visible, agent-visible system notice. |
| `/speak status` | Show session state, playback state, waiting queue depth, queue limit, last playback error, and the parent session's resolved local TTS model, voice, and speed. |

Nonempty arguments use an exact subcommand. Invalid input reports usage without changing state. Argument completion suggests `on`, `off`, and `status` filtered by the typed prefix. Empty arguments show no suggestions, so Enter on bare `/speak` toggles rather than selecting a subcommand.

### Defaults and local TTS

The plugin registers no OMP settings and persists no notification state. Every session starts disabled. The waiting queue limit is fixed at three messages, excluding current playback.

Speech uses OMP's local TTS engine only. Before each playback, resolve the local synthesis model from the parent session's speech-role candidate chain using OMP's local model selection rules, including its local default when the chain contains no local candidate. Resolve voice and speed from the parent session's `tts.localVoice` and `tts.localSpeed` values. Pass the resolved local model ID, voice, and speed explicitly to `omp say` with `--model`, `--voice`, and `--speed`. Do not rely on the child process independently loading the same configuration. The plugin defines no voice list and does not use cloud TTS providers.

Target OMP 18.16.0 or a version verified to support the same APIs. `tts.localModel` is obsolete and must not be read or recreated. Use OMP's host-bound settings registry and speech-role resolution APIs rather than copying their selection logic. Resolve against the parent session's live settings and model registry; do not substitute independently loaded persisted values. Verify imported API subpaths against the compiled OMP executable, not only the source SDK.

## Agent interface

Register `speak_notification` once at extension startup in the primary session only. Keep it active and visible to the primary agent for the full session, including while notifications are disabled. Its name, schema, description, and the static guidance below must never change during a session. Inject the guidance only into the primary session.

### Tool contract

The accepted [checkpoint plan](speech-notification-checkpoints-plan.md) defines the current tool contract. `speak_notification` accepts `action`, `purpose`, optional `checkpointId`, optional `boundary`, `text`, and `reason`. Outcomes and existing attention boundaries require their matching checkpoint identifier. A proactive attention decision requires an exact tool or plan-review boundary. A milestone binds neither. The host validates the tool schema before the extension executes it.

For schema-valid calls, check enabled state first. While disabled, return the disabled result without text validation. While enabled, `speak` rejects Unicode `Cc` control characters in original text, then blank or over-500-code-point trimmed text. `silent` requires a short reason and never queues audio. Queue acceptance resolves speech coverage. Queue rejection leaves a checkpoint pending. A valid repeated resolved identifier is idempotent.

Use the current checkpoint identifier only to decide whether a meaningful outcome needs speech. It does not require audio by itself. Canonical target matching covers only unchanged effective tool arguments or normalized plan path and content. Stale identifiers, changed boundaries, unreadable plans, inactive tools, and invalid text must not queue audio or satisfy coverage.

The tool returns immediately. It must not wait for speech synthesis or playback. If enabled, it queues the trimmed text in FIFO order and reports waiting position and depth. Both exclude current playback. This confirms queue acceptance, not successful playback. If disabled, it returns: `Speech notifications are disabled. Do not retry unless the user enables them with /speak on.`

The agent must never call raw `omp say` or use Bash for speech. The extension owns all process management.

### Static agent guidance

The stable policy lives in `plugins/speak-notifications/src/guidance.ts` and is the essential registered tool description. The primary agent receives the immutable tool definition and policy on each model request. Enablement, checkpoint IDs, and timer reminders remain short transient context; toggling does not change the schema or policy.

Require one short outcome for each substantial task, including negative or inconclusive outcomes. Implementation, debugging, multi-source research, reviews, and long operations normally qualify. Quick answers and routine commands normally stay silent. The agent judges significance and wording without a separate classifier or judge model. Blockers and decisions deserve speech when they need user attention or materially change the plan, not for immediately recovered errors. Speech must execute before a blocking question, never after it in the same tool batch. Combine related outcomes and child results. A milestone is not the final outcome. Queued speech is pending coverage and must not be duplicated. Explicit user requests for silence override optional reminders.

After work qualifies as a candidate substantial task, request one explicit outcome decision in the next existing provider request. Candidates have a successful file edit/write, three work calls, or at least one work call over a minute. Do not count notification decisions as work. Returned background results receive a targeted assessment. Coalesce simultaneous assessments into one short instruction without copied notification history. Preserve task significance across progress decisions and internal continuations. Skip disabled sessions and subagents. If candidate work settles without an outcome decision, request it in at most one bounded continuation. A question without an attention decision is blocked once before resubmission. The model may select silent for trivial, repeated, or explicitly silenced information. Never force audio or alter ordinary empty-response recovery.

### Silence reminder

Use a five-minute active-work countdown while notifications are enabled. Model inference, thinking, foreground work, and running background jobs count. Idle time without running jobs pauses the countdown. User-answer, tool-approval, and plan-review waits pause it even if background work continues. Pause while speech is queued, synthesizing, or playing. All pauses preserve the remaining interval. Successful playback resets elapsed active silence and the countdown. Failure preserves elapsed active silence but delays the next assessment by five active minutes.

At expiry, retain one pending reminder for the next model request without interrupting tools, waits, or in-flight inference. State elapsed active silence and ask whether useful new information deserves speech. The agent may continue silently. Rearm after consuming the reminder, at most once per five active minutes. Idle sessions keep pending reminders without starting a model turn. Turning off, resume, and shutdown clear timer and pending state. Off freezes the reset clock until enabled again. Timers must not keep the process alive.

Toggling notifications does not change the tool schema or static policy. Current state and reminders are per-request context, not changes to the cached static prompt prefix.

## Session state and model feedback

The plugin owns mutable session-local state:

```text
enabled: boolean
activePlayback: boolean // True throughout an owned synthesis/playback process's lifetime.
queue: string[]
lastPlaybackError: string | null
```

Whenever a primary session starts or is resumed, initialize `enabled` to `false`, `activePlayback` to `false`, `queue` to empty, and `lastPlaybackError` to `null`. Do not restore notification state from the transcript. Append a new agent-visible disabled system notice after any restored history, but do not display a startup chip.

`/speak on` and `/speak off` append attributed system notices containing full agent instructions. The transcript renderer shows only a compact sentence, never the internal custom-type heading or instruction body:

- `Speech notifications on.`
- `Speech notifications off.`

Append toggle notices through OMP's supported custom-message mechanism. Before each primary model request, append current enabled state in transient model context so it overrides restored notices. Do not rewrite the static system-prompt prefix or persist this per-request context.

## Queue and playback

- One FIFO worker owns playback.
- Only start the next item after the active process exits.
- It starts `omp say` asynchronously with explicit `--model`, `--voice`, and `--speed` values resolved from the parent session under the local TTS contract above.
- On process failure, discard the failed item, store the error in `lastPlaybackError`, show a visible error immediately, and continue with the next item. `/speak status` retains the latest error until a successful playback clears it or the session ends. Toggling notifications does not clear it.
- `/speak off` clears queued items and stops owned synthesis and playback processes, including their playback children. This also applies while synthesis is running but audio has not started. Record explicit termination as a normal state change, not a playback failure. Do not add special handling or tests for rapid off/on toggles.
- Queue-limit rejection is explicit. Never silently drop a message.
- On session shutdown, clear the queue, stop owned synthesis and playback processes, and release worker resources.

## Non-goals

- Do not enable or alter OMP `speech.enabled` automatic vocalization.
- Do not alter Speech-to-Text, dictation, microphone access, or Speech-to-Text submit triggers.
- Do not make changes to repository `AGENTS.md` files.
- Do not require a skill for agent instructions.
- Do not register plugin settings or persist notification state.

## Tool visibility

The plugin must expose `speak_notification` to the primary session agent only. It must not expose the tool to subagents. Verified primary-only registration on the target OMP version is an implementation prerequisite. If unavailable, report the limitation and obtain an explicit revision of acceptance criterion 3 before implementation. Agent guidance alone does not meet this requirement.

## Local TTS readiness

`/speak on` enables notifications without requiring plugin configuration. It does not guarantee that local synthesis is ready. First playback may need a model download or encounter missing local TTS prerequisites. Show synthesis and playback errors immediately and retain the latest error in `/speak status`.

A local TTS readiness check is optional. Do not require extensive readiness or download testing; normal playback-failure coverage is sufficient.

## Acceptance criteria

1. Installing and enabling the plugin requires no configuration before `/speak on` works.
2. Every new or resumed session starts disabled with an empty queue and no playback error, regardless of previous state or restored notices. The plugin registers no settings and persists no notification state.
3. The primary session agent sees `speak_notification` and stable usage guidance from session start. Subagents do not see or invoke the tool.
4. While disabled, schema-valid tool calls produce no audio, return the disabled result without text validation, and do not queue anything.
5. `/speak on` enables queueing and appends an agent-visible enabled system notice. Startup and `/speak off` append disabled system notices; the latest notice states the current session state. Startup notices have no visible chip. Toggle chips show only `Speech notifications on.` or `Speech notifications off.`, while full instructions remain in model context. Bare `/speak` toggles using those same state transitions, showing full status only when enabling and only the off notice when disabling. Argument completion offers matching `on`, `off`, and `status` options after a typed prefix without intercepting the bare toggle.
6. `/speak off` clears waiting items, stops owned synthesis and playback processes, and appends the disabled notice. Cancellation works before audio begins as well as during playback, without recording a playback error.
7. With working local TTS and notifications enabled, three rapid tool calls play in request order without overlap. Each call returns its enqueue acknowledgement without awaiting synthesis or playback.
8. The fixed capacity of three waiting messages excludes current playback. It rejects only the new excess notification and reports the rejection. Enqueue results report waiting-only position and depth.
9. Tool name, schema, description, and plugin-owned static guidance remain identical before and after `/speak on` or `/speak off`. Appended notices and transient live-state context carry enabled state.
10. Automatic OMP vocalization and Speech-to-Text settings remain unchanged.
11. Unit tests cover commands, disabled behavior, FIFO ordering, capacity, playback failure, explicit playback termination, and shutdown cleanup.
12. Runtime verification links the plugin, restarts OMP, and exercises disabled, enabled, queued, and off-during-playback flows.
13. Playback uses local TTS. It selects a local model from the parent session's speech-role chain using OMP's local selection rules and explicitly passes its model ID and the parent session's resolved `tts.localVoice` and `tts.localSpeed` values to `omp say`. It does not read or recreate `tts.localModel`.
14. While enabled, blank, over-limit, and control-character-containing text is rejected under the tool contract's validation order. Playback failures show an immediate visible error and appear in `/speak status`; successful playback clears the retained error.
15. With notifications enabled, an autonomous OMP session announces a blocker or decision request and the outcome of a long-running operation without any user prompt naming the speech tool or requesting speech.
16. Five minutes of active work, including background jobs, supplies one reminder at the next model request without waking the agent. Idle time without jobs, user waits, and speech pause the remaining interval. Success resets it. Disable, resume, and shutdown cancel pending reminders and freeze the reset timer.
17. Candidate substantial work receives one outcome assessment, including after progress decisions. Missing decisions receive at most one boundary recovery. Questions receive at most one recovery for the same submitted question. Explicit silent decisions produce no audio. Disabled sessions receive no decision enforcement.

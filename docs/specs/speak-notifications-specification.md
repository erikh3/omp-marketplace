# Speak notifications plugin specification

## Purpose

`speak-notifications` gives the primary OMP agent a deliberate, local text-to-speech tool. It does not enable OMP automatic assistant vocalization. The plugin is self-contained and needs no skill, `AGENTS.md` rule, or separate OMP configuration.

Notifications start disabled in every new or resumed session. The user enables them with `/speak on`.

## User interface

### Commands

| Command | Behavior |
| --- | --- |
| `/speak` | Toggle the current session. Enabling shows full status. Disabling shows only the off notice. |
| `/speak on` | Enable notifications for the current session. |
| `/speak off` | Disable notifications, clear waiting notifications, and stop owned synthesis and playback processes. |
| `/speak status` | Show session state, playback state, waiting queue depth, queue limit, last playback error, and resolved local TTS model, voice, and speed. |

Nonempty arguments use an exact subcommand. Invalid input reports usage without changing state. Argument completion suggests `on`, `off`, and `status` for a typed prefix. Empty arguments have no suggestions, so bare `/speak` toggles.

The plugin has no settings and persists no notification state. Every session starts disabled. The waiting queue limit is three messages, excluding current playback.

### Local TTS

Speech uses OMP local TTS only. Before each playback, resolve the local synthesis model from the parent session's speech-role candidate chain with OMP local model selection rules. Resolve voice and speed from the parent session's `tts.localVoice` and `tts.localSpeed`. Pass the resolved model ID, voice, and speed to `omp say` with `--model`, `--voice`, and `--speed`.

Target OMP 18.16.0 or a version with the same APIs. Do not read or recreate obsolete `tts.localModel`. Use the host settings registry and speech-role resolution APIs against the parent session's live settings and model registry.

## Agent interface

Register `speak_notification` once at extension startup in the primary session only. Keep it visible to the primary agent for the full session, including while notifications are disabled. Its name, schema, description, and static policy stay unchanged during a session. Subagents do not receive the tool or guidance.

### Tool contract

The tool accepts only:

```text
speak_notification({
  text: string,
  purpose: "outcome" | "attention" | "milestone"
})
```

The primary agent writes every spoken text. The plugin does not supply fixed phrases, derive speech from a transcript or final answer, or use a classifier or narrator.

For schema-valid calls, first check enabled state. While disabled, return the disabled result without text validation or queueing. While enabled, reject Unicode `Cc` control characters in original text, then blank or trimmed text over 500 Unicode code points. Duplicate and five-minute milestone suppression happen before queue changes. Validation, duplicate suppression, frequency suppression, and capacity rejection leave every waiting item unchanged. They do not consume deduplication or milestone spacing.

On queue acceptance, return immediately with waiting-only position and depth snapshots. The result may include `superseded`, the exact trimmed texts removed from waiting playback. A superseded item will not play and never counts as playback success. Queue acceptance does not confirm successful synthesis or playback. The tool must not wait for playback. The agent must not invoke raw `omp say` or Bash for speech.

Within a user task, normalize text by trimming and normalizing whitespace. Remember at most 32 normalized texts. If the same text was already accepted, return a non-error result with `accepted: false`, `suppressed: true`, and text that says not to retry. The result does not queue speech. Starting a new user task clears this text memory. Disabling notifications and resuming a session reset all notification memory.

Accepted milestones require at least 300000 milliseconds since any accepted speech. Suppress an early milestone with the same non-error, do-not-retry result. Outcomes and attention requests bypass this spacing. Any accepted speech starts the milestone interval.

### Static policy and live state

The stable policy lives in `plugins/speak-notifications/src/guidance.ts` as the registered tool description. It tells the primary agent to:

- announce the outcome of substantial implementation, debugging, multi-source research, reviews, or long operations, including negative and inconclusive outcomes;
- announce material user action before waiting for a decision, approval, authentication, or blocker removal;
- optionally announce a meaningful milestone only when it contains new important information.

The agent judges significance, wording, frequency, and timing. It combines related results and child outcomes. It does not speak for routine reads, edits, intermediate tests, recoverable errors, logs, code, greetings, quick answers, or unchanged status. A milestone does not replace a final outcome.

Each primary-agent request receives a compact current-state developer note ahead of existing messages. The note is metadata, not a task or acknowledgement request. It contains no notification history and creates no extra model request.

The plugin does not create timer reminders or other prompts, wake idle agents, intercept tool calls, block user actions, request silent decisions, use IDs or boundaries, recover omitted notifications, or record unresolved notification status. It does not alter ordinary empty-response recovery.

## Session state and feedback

The plugin owns session-local state:

```text
enabled: boolean
activePlayback: boolean
queue: Array<{ text: string, purpose: "outcome" | "attention" | "milestone", task: number }>
lastPlaybackError: string | null
```

It also keeps bounded notification memory needed for text suppression and milestone spacing. Every primary session start or resume initializes the state with notifications disabled, no active playback, an empty queue, and no playback error. It does not restore notification state from the transcript.

Startup state reaches the agent without a visible chip. Toggle notices render only:

- `Speech notifications on.`
- `Speech notifications off.`

The live-state developer note overrides restored notices for the next primary request.

## Queue and playback

- One serial worker owns playback. It starts the next item only after the active process exits.
- Waiting attention messages have priority. A new attention message inserts after existing waiting attention messages and before all ordinary waiting messages. Attention messages retain FIFO order within their priority. Outcome and milestone messages retain FIFO order with one another.
- Active playback is never reordered, removed, or interrupted by a new notification. Every active phrase runs to process completion unless `/speak off` cancels it.
- Before capacity is evaluated, a new milestone removes every waiting milestone across all tasks. A new outcome removes waiting milestones for the same internal task only. An attention message does not supersede waiting items.
- The limit remains three waiting items, excluding active playback. Compute prospective supersession first, then reject atomically when adding the new item would still exceed that limit. A rejected call removes no waiting item.
- Start `omp say` asynchronously with the resolved local `--model`, `--voice`, and `--speed` values. On process failure, discard the failed item, store the error in `lastPlaybackError`, show a visible error, and continue with the next item. A successful playback clears the retained error.
- `/speak off` clears waiting items and stops owned synthesis and playback, including child playback processes. Explicit termination is not a playback failure. On session shutdown, clear the queue, stop owned processes, and release worker resources.

First playback can download the local model. `/speak on` does not guarantee that synthesis is ready. Show synthesis and playback errors immediately and retain the latest error in `/speak status`.

## Non-goals

- Do not enable or alter OMP `speech.enabled` automatic vocalization.
- Do not alter speech-to-text, dictation, microphone access, or speech-to-text submit triggers.
- Do not register plugin settings or persist notification state.
- Do not expose the tool to subagents.
- Do not classify significance, compose speech, read transcripts, or force tool calls.
- Do not add timer prompts, autonomous turns, interception, blocking, notification enforcement, or retry recovery.

## Acceptance criteria

1. Installing and enabling the plugin needs no configuration before `/speak on` works.
2. Every new or resumed session starts disabled with an empty queue and no playback error, regardless of prior state or restored notices. The plugin persists no notification state.
3. The primary agent sees `speak_notification` and stable policy from session start. Subagents do not see or invoke it.
4. The tool schema contains only `text` and `purpose`, where purpose is `outcome`, `attention`, or `milestone`.
5. While disabled, schema-valid calls produce no audio, return the disabled result without text validation, and do not queue anything.
6. `/speak off` clears waiting items, stops owned synthesis and playback processes, and appends the disabled notice. Cancellation works before audio begins and during playback without recording a playback error.
7. With working local TTS and notifications enabled, accepted calls play serially without overlap. An active phrase keeps its place until it exits. Each call returns its enqueue acknowledgement without waiting for synthesis or playback.
8. Attention messages play before waiting ordinary messages, preserve FIFO order within attention priority, and never interrupt active playback. Outcomes and milestones preserve FIFO order among ordinary waiting messages.
9. The fixed capacity of three waiting messages excludes current playback. The plugin evaluates capacity after prospective milestone supersession and rejects atomically when still full.
10. A new milestone supersedes all waiting milestones across tasks. A new outcome supersedes only waiting milestones for its own internal task. Active playback is never superseded. The acceptance result returns the exact trimmed superseded texts and waiting position and depth snapshots. Superseded items do not play and are not recorded as playback success.
11. Blank, over-limit, control-character, duplicate, frequency, and capacity rejections leave all waiting messages unchanged. Rejected calls do not consume text suppression or milestone spacing.
12. Within a user task, accepted normalized text is suppressed on a repeated call. The suppressed result is not an error, says not to retry, and queues nothing. The plugin remembers at most 32 texts and clears them for a new user task.
13. An accepted milestone less than five minutes after any accepted speech is suppressed without error or queueing. Accepted outcomes and attention requests bypass that gate. Disable and resume reset notification memory.
14. The plugin uses no timer prompt, autonomous model turn, transcript reader, final-answer reader, classifier, fixed spoken text, ID, boundary, silent-decision path, call interception, blocking, recovery, or unresolved status.
15. Unit tests cover commands, disabled behavior, serial playback, attention priority, cross-task and same-task milestone supersession, capacity after prospective supersession, rejection atomicity, validation, duplicate suppression, milestone spacing, playback failure, explicit playback termination, and shutdown cleanup.
16. Runtime verification links the plugin, restarts OMP, and exercises disabled, enabled, attention priority, milestone supersession, outcome task boundaries, duplicate suppression, milestone spacing, and off-during-playback flows.
17. Playback uses local TTS and explicitly passes a model selected from the parent session's speech-role chain with parent `tts.localVoice` and `tts.localSpeed`. It does not read or recreate `tts.localModel`.

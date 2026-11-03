# Speak Notifications plugin specification

## Purpose

Add a self-contained personal OMP plugin named `speak-notifications`. It gives agents deliberate, short text-to-speech notifications without enabling OMP's automatic assistant vocalization.

The plugin must be installable from this marketplace without a skill, `AGENTS.md` rule, or separate OMP configuration. Notifications start disabled in every session. The user enables them with `/speak on`.

## User interface

### Commands

| Command | Behavior |
| --- | --- |
| `/speak on` | Enable deliberate speech notifications for the current session. Append a visible, agent-visible system notice. |
| `/speak off` | Disable notifications for the current session. Clear queued notifications and stop owned synthesis and playback processes. Append a visible, agent-visible system notice. |
| `/speak status` | Show session state, playback state, waiting queue depth, queue limit, last playback error, and the parent session's resolved local TTS model, voice, and speed. |

Commands use an exact subcommand. Invalid input reports usage without changing state.

### Defaults and local TTS

The plugin registers no OMP settings and persists no notification state. Every session starts disabled. The waiting queue limit is fixed at three messages, excluding current playback.

Speech uses OMP's local TTS engine only. Before each playback, resolve the local synthesis model from the parent session's speech-role candidate chain using OMP's local model selection rules, including its local default when the chain contains no local candidate. Resolve voice and speed from the parent session's `tts.localVoice` and `tts.localSpeed` values. Pass the resolved local model ID, voice, and speed explicitly to `omp say` with `--model`, `--voice`, and `--speed`. Do not rely on the child process independently loading the same configuration. The plugin defines no voice list and does not use cloud TTS providers.

Target OMP 18.16.0 or a version verified to support the same APIs. `tts.localModel` is obsolete and must not be read or recreated. Use OMP's host-bound settings registry and speech-role resolution APIs rather than copying their selection logic. Resolve against the parent session's live settings and model registry; do not substitute independently loaded persisted values. Verify imported API subpaths against the compiled OMP executable, not only the source SDK.

## Agent interface

Register `speak_notification` once at extension startup in the primary session only. Keep it active and visible to the primary agent for the full session, including while notifications are disabled. Its name, schema, description, and the static guidance below must never change during a session. Inject the guidance only into the primary session.

### Tool contract

```text
speak_notification({ text: string })
```

- Accept one plain-text notification.
- For schema-valid calls, check enabled state first. While disabled, return the disabled result without text validation. While enabled, reject any Unicode `Cc` control character in the original text, including newlines and tabs. Then trim leading and trailing whitespace and reject empty text or text exceeding 500 Unicode code points. Queue the trimmed text.
- Return immediately. It must not wait for speech synthesis or playback.
- If notifications are enabled, enqueue the message in FIFO order and report its one-based position in the waiting queue and the waiting queue depth at enqueue time. Both exclude current playback; this is an enqueue acknowledgement, not confirmation that speech succeeded.
- If the queue is full, reject the new message and report that it was not spoken. This should be exceptional: static agent guidance limits notifications to material events and one per task phase.
- If notifications are disabled, do not start or queue speech. Return: `Speech notifications are disabled. Do not retry unless the user enables them with /speak on.`
- The tool must never invoke an additional overlapping playback process.

The agent must never call raw `omp say` or use Bash for speech. The extension owns all process management.

### Static agent guidance

Inject this stable guidance at every session start. Do not mutate it after `/speak on` or `/speak off`.

```text
## Deliberate speech notifications

Use `speak_notification` for deliberate text-to-speech notifications only. It is the only permitted speech path. Do not invoke `omp say` or any other speech command through Bash. Subagents must not invoke this tool.

Refer to the latest speak-notifications system notice for the session's enabled state. The tool also reports whether notifications are enabled. If it reports disabled, do not retry unless the user subsequently enables notifications.

When enabled, you MUST call `speak_notification` when you encounter a blocker or need the user's decision, and when a long-running operation completes or fails. Choose a short outcome or required-action message yourself; do not wait for the user to request speech. Before ending a substantial task, announce its outcome once. Brief updates at meaningful phase boundaries are allowed. Do not speak every response, greetings, routine tool progress, repeated status, markdown, paths, URLs, code, tables, or logs.

Use one or two plain sentences, normally under 25 words. Lead with the outcome or required action. Combine related outcomes into one notification. Do not repeat an event already announced. Queue at most one notification per task phase unless the user requests a walkthrough.
```

Toggling notifications does not change the plugin-owned static guidance or tool schema. Provider prompt-cache reuse remains provider-dependent.

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

The agent refers to the latest notice for the current state. Append notices through OMP's supported system-notice mechanism, not user-authored messages or a rewrite of the static system-prompt prefix. Verify that mechanism before implementation.

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
5. `/speak on` enables queueing and appends an agent-visible enabled system notice. Startup and `/speak off` append disabled system notices; the latest notice states the current session state. Startup notices have no visible chip. Toggle chips show only `Speech notifications on.` or `Speech notifications off.`, while full instructions remain in model context.
6. `/speak off` clears waiting items, stops owned synthesis and playback processes, and appends the disabled notice. Cancellation works before audio begins as well as during playback, without recording a playback error.
7. With working local TTS and notifications enabled, three rapid tool calls play in request order without overlap. Each call returns its enqueue acknowledgement without awaiting synthesis or playback.
8. The fixed capacity of three waiting messages excludes current playback. It rejects only the new excess notification and reports the rejection. Enqueue results report waiting-only position and depth.
9. Tool name, schema, description, and plugin-owned static guidance remain identical before and after `/speak on` or `/speak off`. Only appended state notices change the agent's state information.
10. Automatic OMP vocalization and Speech-to-Text settings remain unchanged.
11. Unit tests cover commands, disabled behavior, FIFO ordering, capacity, playback failure, explicit playback termination, and shutdown cleanup.
12. Runtime verification links the plugin, restarts OMP, and exercises disabled, enabled, queued, and off-during-playback flows.
13. Playback uses local TTS. It selects a local model from the parent session's speech-role chain using OMP's local selection rules and explicitly passes its model ID and the parent session's resolved `tts.localVoice` and `tts.localSpeed` values to `omp say`. It does not read or recreate `tts.localModel`.
14. While enabled, blank, over-limit, and control-character-containing text is rejected under the tool contract's validation order. Playback failures show an immediate visible error and appear in `/speak status`; successful playback clears the retained error.
15. With notifications enabled, an autonomous OMP session announces a blocker or decision request and the outcome of a long-running operation without any user prompt naming the speech tool or requesting speech.

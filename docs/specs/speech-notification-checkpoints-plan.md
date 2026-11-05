# Speech notification checkpoints plan

## Status

Superseded by the `0.6.0` design in the [Speak notifications plugin specification](speak-notifications-specification.md). The earlier checkpoint, boundary, recovery, unresolved-status, and timer-prompt design is not the current contract.

## Why the design changed

The primary agent must author the notification text and decide whether it is useful. The problem is notification frequency and trigger points, not missing fixed phrases or a missing narrator. Host enforcement added IDs, boundaries, silent decisions, interception, blocking, and recovery without making that judgment reliable.

The current design keeps a small optional tool. The host owns local playback, cancellation, validation, and narrow suppression rules. The agent owns the message and chooses whether to call the tool.

The design borrows host-owned suppression and lifecycle separation from [Peon Ping](https://github.com/PeonPing/peon-ping/blob/main/adapters/omp/peon-ping.ts), while retaining agent-authored speech through an optional delivery tool like [F1LT3R agent-notify](https://github.com/F1LT3R/agent-notify). It does not copy fixed event sounds, automatic response narration, or model-decision enforcement.

## Current contract

`speak_notification` accepts only `text` and `purpose`, where purpose is `outcome`, `attention`, or `milestone`.

- The primary agent announces substantial results, including negative and inconclusive results.
- The primary agent announces material user action before waiting for it.
- The primary agent may announce a meaningful milestone with new important information.
- Accepted milestones are spaced at least five minutes from any accepted speech. Outcomes and attention requests bypass that gate.
- The plugin suppresses repeated trimmed, whitespace-normalized text within a user task. It stores at most 32 texts. New tasks clear text memory. Disable and resume reset all notification memory.
- A suppression result is non-error and says not to retry. Invalid text, frequency suppression, duplicate suppression, and queue rejection leave waiting messages unchanged and do not consume suppression or spacing.
- Waiting attention messages have priority, with FIFO order within that priority. Ordinary messages remain FIFO. No queued item interrupts active speech.
- A new milestone supersedes every waiting milestone across tasks. A new outcome supersedes waiting milestones for the same internal task only. The acceptance result reports the trimmed texts that will not play. Supersession never affects active playback.
- Capacity is three waiting items and is evaluated after prospective supersession. Rejection is atomic if the prospective queue remains full.
- The plugin has no timer prompts, wakeups, transcript or final-answer reading, fixed speech, classifier, IDs, boundaries, silent decisions, interception, blocking, retries, recovery, or unresolved status.

The specification is authoritative for implementation and acceptance criteria.

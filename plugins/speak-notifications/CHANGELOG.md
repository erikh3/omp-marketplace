# Changelog

## 0.6.0

- Prioritize waiting attention messages while preserving FIFO order within the attention and ordinary queues. Active playback remains uninterrupted.
- Coalesce waiting milestones across the session. An outcome removes waiting milestones for its own task.
- Return superseded waiting texts with queue-position snapshots. Rejections leave the waiting queue unchanged.

## 0.5.0

- Replace checkpoint actions, identifiers, boundary matching, silent decisions, recovery, and unresolved status with `text` and `purpose` calls.
- Keep agents responsible for notification wording and trigger points. The plugin does not classify work, read transcripts, supply fixed speech, prompt on a timer, wake the agent, intercept calls, block user actions, or add model turns.
- Add task-scoped, bounded whitespace-normalized text suppression. Suppressed calls return a non-error result that says not to retry.
- Limit accepted milestone speech to one per five minutes after any accepted speech. Outcomes and attention requests bypass the limit.
- Keep FIFO playback, queue capacity, validation, cancellation, and primary-only ownership unchanged.

This `0.x` minor release intentionally changes the incompatible tool contract.

## 0.4.1

- Preserve blocked attention targets when a nested device transport completes, so unchanged retries use one recovery and can be released.
- Deliver expired timer assessments before optional outcome metadata and consume them only after an active request receives the instruction.
- Include continued active work in pending timer elapsed time.
- Preserve task checkpoint ownership across host-owned automatic abort recovery.
- Clear background-result candidate state when a new user task begins.
- Retire consumed or superseded unresolved checkpoints without marking them accepted or exhausting active admission.
- Reject silent decisions for unresolved checkpoints instead of acknowledging successful coverage.

## 0.4.0

- Add session-local outcome and attention checkpoints with task and enablement invalidation, canonical tool and plan targets, bounded unresolved status, and idempotent resolved identifiers.
- Require current outcome identifiers and exact proactive attention targets. Reject stale identifiers, inactive tools, revised arguments, unreadable plans, invalid text, and rejected queues without audio coverage.
- Block `ask` and known installed Plannotator review or annotation actions once for a missing attention decision. Missing recovery decisions become text-only unresolved status without fabricated calls. Keep approval and native-review prompts available when no safe pre-wait turn exists.
- Keep live enablement first for decision paths while lifecycle cleanup continues disabled. Preserve timer reminders until the instruction that selected one completes.
- Keep live state and decision reminders compact and transient. Do not copy notification history or invoke a judge model.
- Assess returned background results, combine related reminders, and require speech before material user-action questions.
- Count foreground and background work toward the five-minute reminder. Pause during idle time without jobs, user waits, and speech; preserve the remaining interval.
- Retain primary-agent judgment, optional timer reminders, and one combined notification per material outcome.
- Replace text-only tool calls with explicit speak-or-silent actions and outcome, attention, or milestone purposes. Silent decisions require a reason and produce no audio.
- Request a missing task decision once at completion and block a question once before resubmission without an attention decision. Timer expiry never forces audio.
- Preserve a blocked question's first preflight dispatch through its recovery response. The first response may record a valid current attention decision before the next question attempt; only a later omission becomes unresolved.
- Exclude OMP's top-level `i` intent metadata from tool-boundary identity, so the same question retains its coverage when its display intent changes.
- Send outcome recovery through OMP's hidden next-turn delivery instead of a queued follow-up message.
- Make the current outcome identifier available after the first enabled work result. This lets the primary agent announce a substantial one-read negative finding without forcing a decision for routine work. Candidate thresholds still control recovery.
- Mark live state context as metadata and direct the agent to continue the current user task without acknowledging it.
- Release a question after its one recovery response omits a decision instead of blocking it again.
- Promote an optional outcome identifier to required coverage when existing candidate thresholds qualify the same task, without replacing its ID.
- State that an optional outcome identifier is only valid for an outcome. Direct proactive attention decisions to an exact boundary until the plugin supplies an attention ID.
- Make transient live state passive metadata that tells the agent to answer the user, not the state note.

## 0.3.1

- Assess optional speech completion in the next existing model request before the final answer instead of starting a post-answer turn. Declining speech no longer triggers empty-response retries.

## 0.3.0

- Clarify substantial outcomes, user-action blockers, and cases that should stay silent.
- Supply live enabled state before each model request and request at most one optional completion check for candidate substantial work.
- Add a five-minute silence reminder. Pause during speech, reset after successful playback, coalesce while idle without waking the model, and reset/freeze when disabled.

## 0.2.1

- Show only the off notice when bare `/speak` disables notifications. Keep full status when it enables them.

## 0.2.0

- Add argument completion for `on`, `off`, and `status` after a typed prefix.
- Make bare `/speak` toggle notifications and immediately show the resulting status.

## 0.1.3

- Move unchanged agent guidance into its own source module.

## 0.1.2

- Format status as separate state and local TTS rows. Omit playback errors when none exist.

## 0.1.1

- Require autonomous notifications for blockers, decision requests, long-running operation outcomes, and substantial task completion.
- Hide startup notices and render toggle notices as compact sentences while preserving full instructions in model context.

## 0.1.0

- Add primary-agent-only deliberate local speech notifications and stable usage guidance.
- Add `/speak on`, `/speak off`, and `/speak status`, with session-local state that starts disabled.
- Add a three-item waiting queue, explicit capacity rejection, visible playback errors, and owned-process cancellation.
- Resolve local speech model, voice, and speed from the parent OMP session and pass them explicitly to `omp say`.

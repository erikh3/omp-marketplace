# Speech notification checkpoints: specification and implementation plan

## Status and handoff

Status: all six PR #63 review defects are corrected in `0.4.1`. Deterministic verification passed, and the primary agent drove a fresh speech-enabled OMP session in a new Herdr tab. The [checkpoint report](speech-notification-checkpoints-report.md) records exact runtime identity, successful paths, and observed significance and output-quality failures. The smoke is not release approval.

This document records the user's final direction. It supersedes the notification-decision and enforcement sections of the earlier speech specification and prototype. Keep the existing command, local TTS, queue, and cancellation contracts unless this document explicitly changes them.

Use the existing writable checkout:

```text
/Users/I589812/.herdr/worktrees/omp-marketplace/speech-decision-reminders
```

Branch: `speech-decision-reminders`. Draft PR #63 contains the checkpoint implementation; the corrected plugin version is `0.4.1`. It remains uninstalled. Reuse this worktree and preserve unrelated changes. Check current ownership and repository state before editing.

Read `AGENTS.md` and the global git, TypeScript, and review rules before the operations they govern. Do not commit, install, or open a PR unless the user requests it.

## Goal

Use OMP-level checkpoints to make notification decisions explicit, bounded, and observable. The primary agent decides whether speech is useful and writes the notification.

The plugin must be LLM-agnostic. It must use OMP tooling and extension APIs, not provider-specific request formats. Future providers must work through the same plugin path.

The reliability contract is validated decisions with bounded, observable failure. It is not a guarantee that every model will make the correct judgment.

## Required order

**Check live speech enablement first.** If speech is off, return before detecting notification candidates, creating checkpoints, consuming reminders, or requesting recovery.

Apply this order to every notification-decision entry point:

1. Check live enabled state.
2. Check that this is the primary agent and the event is eligible.
3. Detect or locate the relevant checkpoint.
4. Request or validate a decision.
5. Execute accepted speech once, or record silence.
6. Request one recovery if the decision is missing and a safe pre-wait or settlement recovery point exists.
7. Record unresolved failure if recovery fails or the boundary has no safe recovery point.

Timer and session cleanup must still run while disabled. A short disabled-state instruction may remain in request context to override older enabled notices. Static tool registration and static policy may remain available while disabled.

Recheck live enablement immediately before decision acceptance and speech enqueue. Disabling clears pending checkpoints and recovery work. A late response from a previous enablement period cannot queue speech or complete a new checkpoint.

## Notification policy

| Event | Agent decision |
| --- | --- |
| Substantial implementation, investigation, review, or research finishes | Announce its outcome once, including failure or inconclusive results. |
| User must approve, choose, authenticate, or remove a material blocker | Announce the required action before waiting for the user. |
| Background work returns an important result the user requested | Announce the result, not merely process completion. |
| Work reveals an important risk or materially changes direction | Consider one progress notification for new information. |
| Routine reads, edits, intermediate tests, retries, or todo updates | Stay silent. |
| Quick lookup, arithmetic, typo correction, or unchanged status | Stay silent. |
| Speech is disabled or the user requests silence | Produce no audio. |

Judge significance from the user's goal. Tool counts and durations identify candidates only; they do not prove significance.

Combine related results and child-agent outcomes. Only the primary agent speaks. A progress notification does not replace the final outcome. Queued speech is pending coverage, not successful playback, and must not be queued again for the same event.

Use one or two plain sentences, normally under 25 words. Do not read code, paths, logs, tables, or the final answer aloud. Optional progress notifications normally occur at most once per five minutes. Final outcomes and urgent user actions do not wait for that interval.

## Checkpoint contract

### Identity and state

Use a small session-local record for each currently relevant outcome or attention boundary:

```text
id: opaque checkpoint identifier
purpose: outcome | attention
decision: pending | speak | silent | unresolved
recoveryAttempted: boolean
```

Keep playback state separate. A `speak` decision means validated text was accepted into the queue, not that playback succeeded.

Bind each checkpoint to the current task generation and specific boundary. Do not let one attention decision satisfy unrelated questions. Do not let a milestone satisfy an outcome checkpoint. Do not let a decision from an older task or disabled period satisfy a current checkpoint.

Use bounded storage. Retain only current checkpoints and compact unresolved status. Do not retain a second transcript or copy notification text into reminder context.

After the first enabled primary-agent work result, expose the current task's optional outcome identifier in request context. The identifier is valid only for purpose `outcome` and gives the primary agent a way to announce a substantial one-read result. It does not make that work a substantial candidate or request a decision. Existing candidate thresholds still govern recovery and unresolved status. When they qualify, promote the same identifier to required coverage. Preserve the identifier until the outcome is resolved or invalidated. A valid proactive outcome decision with that identifier covers later settlement of the same outcome without another decision request.

Attention boundaries may not exist when the agent proactively announces a required action. Accept an identifier-free attention decision only with an explicit `boundary` target under the contract below. Create and resolve its checkpoint atomically after validation and queue acceptance, or after accepting silence. Never match notification text, adjacency, or an unbound attention flag to a later question.

The exact TypeScript representation may follow existing conventions. Preserve these observable invariants.

### Tool decisions

Keep the prototype's explicit `speak_notification` actions and purposes:

```text
speak_notification({
  action: "speak" | "silent",
  purpose: "outcome" | "attention" | "milestone",
  checkpointId?: string,
  text?: string,
  reason?: string,
  boundary?: { kind: "tool", toolName: string, input: object }
    | { kind: "plan-review", planFilePath: string }
})
```

Require `checkpointId` when answering an existing outcome or attention checkpoint, with a matching purpose. An identifier-free outcome decision is invalid; only milestones may omit both an identifier and a boundary. An identifier-free proactive attention decision requires `boundary`. Reject calls containing both `checkpointId` and `boundary`, or a milestone with either field, instead of guessing which identity wins.

For a tool boundary, use the effective tool name and complete execution arguments that the host will validate, approve, and run. This includes `ask` and tools that need approval or authentication. For a plan-review boundary, read the named plan through the host and bind coverage to its normalized absolute path and current content fingerprint. Retain a compact target fingerprint with the task and enablement generations, not copied arguments, plan content, or notification text. Reject unreadable plans and invalid targets without audio or coverage.

Match a later boundary only to that exact target in the current generations. Object property order does not change identity; changed question options, command arguments, or plan content do. A resubmitted blocked call gets the same checkpoint even when its dispatch `toolCallId` changes. Once the matching question, approval, or review is opened or cancelled, consume its target association so a later occurrence requires a new checkpoint. A proactive tool target that executes without a user wait consumes its association without covering another call.

Before enqueueing, check for an existing decision for the same target or identifier. Repeated valid decisions are idempotent. An accepted proactive attention decision followed by its matching boundary produces no recovery request and no second notification. An unrelated boundary remains pending. A queued item that later fails playback remains accepted decision coverage and must not be requeued.

- `speak` requires valid plain text under the existing queue validation rules.
- `silent` requires a short explanation, not chain-of-thought. It produces no audio.
- Disabled calls return the existing disabled result and satisfy no checkpoint.
- Invalid or stale decisions produce no audio and satisfy no checkpoint.
- Queue rejection leaves the decision pending; it is not accepted speech coverage.
- Repeated valid decisions for an already resolved identifier are idempotent and produce no duplicate audio.
- Existing playback failures remain playback failures. Do not represent them as missing model decisions or automatically resubmit speech.

The host's normal tool validation and execution path must remain authoritative. Do not fabricate tool calls, parse final-answer text as a notification, or invoke a speech command from agent Bash.

### Candidate boundaries

Use existing OMP lifecycle and tool events. Verify their actual behavior on the installed host before relying on them.

- Outcome: candidate substantial work reaches completion, or awaited background results provide a materially new task outcome.
- Attention: the primary agent is about to submit a user question, request approval or authentication, hand a plan to review, or wait for removal of a material blocker.
- Timer: optional assessment of useful information, not a required checkpoint merely because time passed.

Coalesce related background results. Do not create one checkpoint for each child, test, tool result, or todo transition.

Preserve a pending outcome across internal continuations. A new user task starts a new generation. If new background evidence arrives after an earlier outcome decision, it may require a new checkpoint; do not reopen a resolved checkpoint for unchanged information.

### Pre-wait attention paths

Use the following paths without copying OMP's approval resolver or changing user approval rules. Agent guidance must request a targeted attention decision before a known approval, authentication step, or plan handoff. Unknown approval requirements are not evidence that every tool needs a notification.

| Boundary | Decision and interception path | Missing-decision behavior |
| --- | --- | --- |
| `ask`, including authentication choices and blocker questions | The agent may first record a targeted proactive decision. Otherwise intercept `tool_call` before scheduling and expose the matching checkpoint identifier in one blocked-call reason. | After one decision recovery, permit resubmission of that exact target and record unresolved status if no valid decision was accepted. |
| Tool approval or a tool that opens an authentication wait | Before submitting a known attention-requiring operation, the agent records a decision targeted to the effective tool name and arguments. At `tool_call`, associate matching coverage with that dispatch; revalidate it when the host confirms approval or authentication is required. | If the host first reveals the wait during execution and no decision covers it, record unresolved status without requesting a model turn while execution or the user wait is pending. Keep the normal approval or authentication prompt available. |
| Tool-launched plan review | Record a decision for the exact review-opening tool call before submission. Intercept that tool's `tool_call` if it is known to open a review, using the same one-recovery rule as `ask`. | Release the exact resubmitted call after bounded failure. The later review-open event consumes its coverage or confirms unresolved status; it is not another recovery boundary. |
| Native OMP plan review after planning settles | Record a proactive plan-review decision bound to the current plan path and content before returning the plan. A verified pre-settlement event may request the one recovery only when the host exposes the specific forthcoming review target. | If no safe pre-open recovery point exposes that target, record unresolved status when the review opens without coverage. Do not dismiss, reopen, or delay the review to obtain a decision. |
| Material blocker reported without a dialog | Include the required action in the task outcome decision before settlement. | Use the existing bounded outcome recovery and preserve the task result after unresolved failure. |

The installed OMP 18.16.0 source establishes these limits: model-issued `tool_call` runs before scheduling, execution start, and approval; its passive `additionalContext` reaches a later request after tool results. The approval wrapper emits `tool_approval_requested` before `requestApproval`, but the current tool is still executing. Native review code calls `showPlanReview` before emitting `plan_review_requested`. Neither wait event provides a safe model-decision round trip before that wait. Verify the same ordering on the actual runtime before relying on it.

Use wait lifecycle events to confirm the actual boundary, consume matching coverage, and pause the countdown. Never treat those events as pre-wait decision recovery or automatically speak from them. Track nested device calls using their effective targets. If host input revision changes the operation after a proactive decision, the revised target is uncovered; never use coverage for the original arguments to approve or announce a different operation.

For a boundary with no safe pre-wait model-decision opportunity, `unresolved` records the missing notification with a compact cause and `recoveryAttempted: false`. Emit one concise text-only notice and aggregate it with related unresolved records. This is an observed limitation, not silence or successful notification use. No plugin-owned turn may start during the wait or after it merely to repair that notification. The required-action policy still applies to proactive agent decisions, but the plugin cannot guarantee compliance on those paths.

### Recovery and unresolved status

A reminder being delivered does not resolve a checkpoint. A recovery request being sent does not resolve a checkpoint.

At a missing-decision boundary, allow at most one plugin-owned recovery request. Use OMP's ordinary custom-context and lifecycle mechanisms. Do not loop with repeated `decision: "block"` refusals. Do not modify ordinary OMP empty-response recovery.

After failed recovery, set `decision` to `unresolved`. Preserve the user's task result and record notification failure separately. Do not fabricate silence, speech, or success.

For attention with a safe pre-wait interception point, do not hold an important question, operation, or review hostage to notification compliance. After one failed recovery, permit resubmission of that exact target and record the unresolved notification. New dispatch IDs do not restart recovery. Mark failure by the end of the recovery turn even if the model omits resubmission; do not fabricate or execute the missing call. Resubmission permission is not a resolved attention decision. A boundary first observed without a safe recovery point follows the immediate-unresolved rule above instead.

OMP 18.16.0 emits `tool_execution_start` for the call that `tool_call` blocks. Treat that as the original blocked dispatch, not a resubmission. The recovery deadline begins with the next model turn. A later same-target attempt without a decision becomes unresolved. OMP-generated top-level `i` intent metadata does not contribute to a tool target. All other top-level execution arguments remain part of its identity.

The transient live-state instruction is session metadata. It must state that it is not a task or acknowledgement request and direct the agent to answer the user rather than the state note. Do not replace the user's task, mutate provider payloads, or add an autonomous turn to deliver state.

For outcome, let the task settle after bounded failure. Do not repeat its final answer. Emit one concise text-only unresolved notice and retain compact status for `/speak status`. Do not create another model request to explain the failure. Aggregate related unresolved records instead of issuing routine failure chatter.

Cancellation, speech off, session switch, and shutdown clear pending recovery without an unresolved warning. They are deliberate state changes, not model failures.

## Countdown contract

The five-minute countdown uses monotonic active-work time.

| State | Countdown |
| --- | --- |
| Model request or thinking | Run. |
| Foreground tool work | Run. |
| Primary agent idle while background jobs run | Run. |
| Idle with no running background jobs | Pause and preserve remaining time. |
| Waiting for user answer, tool approval, or plan review | Pause, even if background jobs run. |
| Speech queued, synthesizing, or playing | Pause. |
| Speech off | Reset and freeze. |

Successful playback resets the full interval. Queue acceptance alone does not reset it. Failures preserve elapsed active silence but defer another timer assessment for one full active interval.

Expiry retains one pending reminder for the next actual model request. It must not wake an idle agent, interrupt tools, or force audio. Count active time that continues after expiry while the reminder remains pending.

User waits can overlap. Resume only after all waits and speech have ended. Use one-shot timers; do not poll the clock or background jobs in a recurring loop.

## Context and runtime limits

- No provider names, model names, payload mutation, transport wrappers, `/force` command recursion, or native tool-choice assumptions.
- No separate judge or classifier by default.
- No notification-history injection or repeated full-policy messages.
- One short transient live-state instruction per model request.
- At most one combined checkpoint or timer instruction in that request.
- Checkpoints and recovery are consumed only by actual active-loop requests, not idle context inspection or dump operations.
- Reminder generation must be cheap and must not scan the complete transcript per request.
- Do not claim a tool-schema guarantee forces tool selection or correct significance judgment.

## Existing prototype and evidence

Relevant files:

```text
plugins/speak-notifications/src/index.ts
plugins/speak-notifications/src/guidance.ts
plugins/speak-notifications/src/reminder-clock.ts
plugins/speak-notifications/src/controller.ts
plugins/speak-notifications/test/completion.test.ts
plugins/speak-notifications/test/reminder-clock.test.ts
plugins/speak-notifications/README.md
plugins/speak-notifications/CHANGELOG.md
plugins/speak-notifications/package.json
```

The timer implementation already counts foreground/background work and pauses user waits and speech. Two confirmed review defects were fixed: elapsed time after pending expiry, and idle context inspection consuming a reminder. Preserve those regressions.

The prototype still uses `outcomeDecided`, `attentionDecided`, `boundaryChecked`, and `checkedQuestion`. These do not distinguish recovery attempted from an unresolved decision. The question resubmission and completion paths stop enforcing after one attempt without recording that failure. Replace this bookkeeping.

The current README incorrectly says portable enforcement requires a public host forcing API. Remove that claim. OMP-level validation and bounded unresolved outcomes do not require provider forcing.

Historical verification before this iteration: 63 plugin tests passed, typecheck passed, marketplace validation passed, and an integrated timer/context smoke passed. These results describe the prototype, not the implementation required by this plan.

The 2026-11-04 interactive session established one accepted outcome and correct silence for a quick lookup. It also established that the first blocked `ask` emitted `tool_execution_start` at 17:15:41.320, followed by its recovery result and an unresolved notice at 17:15:41.328. The next response supplied the instructed identifier at 17:15:43.427, but the tool rejected it because the plugin had already marked it unresolved. The correction retains the originating dispatch, permits the next full model request to decide, and then records unresolved only after that response omits a decision. This is a host lifecycle defect, not model noncompliance.

The same session included extra acknowledgements after state notices and a missing-data reply of `Noted.` rather than the requested conclusion. The state-notice cause remains unproven. The plugin now keeps state custom-message content to a passive state record and continues to put the live enabled state in transient context. Further interactive evaluation must establish whether that changes model behavior.

The later interactive matrix confirmed the attention recovery repair. The first ID-less attention attempt rejected, the `ask` call blocked, the next model request recorded `speech-4-2-2`, and the resubmitted question opened under a new dispatch ID. It also showed a substantial one-read missing-field investigation returning its textual conclusion before an ID-less outcome call rejected. The optional first-work outcome identifier repairs that valid-decision gap while leaving automatic recovery thresholds unchanged. The same matrix observed an accepted outcome speech call followed by an assistant `Noted.` instead of the requested textual summary. The per-request live state is now explicit metadata that directs the model to continue the current user task. Further real-model evaluation must confirm the response behavior.

The completed later matrix established accepted outcome decisions for the build result and a substantive one-read missing-field result, and established that the textual user results appeared before notification calls. It also showed purpose-mismatch retries when the model used the optional outcome ID for attention. The plugin keeps that call invalid, adds an actionable mismatch result, and makes context and static guidance state the ownership rule. A final extra acknowledgement after the negative outcome remained an output-quality concern, so transient state is now passive metadata that directs the agent to answer the user rather than the note. This wording requires a later real-model check; it does not claim the acknowledgement defect is resolved.

Optional local evidence, which may expire and must not be required to resume:

```text
/tmp/speech-decision-runtime/boundary-frames.json
/tmp/speech-decision-runtime/sap-boundary-wire.jsonl
/tmp/speech-decision-runtime/release-once-frames.json
/tmp/speech-decision-runtime/sap-release-once-wire.jsonl
```

Do not publish raw provider payload artifacts. They may contain prompt context or sensitive data. Keep public evidence limited to relevant sanitized events.

## Implementation plan

### Phase 1: inspect and define checkpoint state

1. Confirm ownership of the existing worktree and preserve unrelated changes.
2. Read current plugin code, tests, and installed OMP event types.
3. Implement explicit checkpoint identity, decision state, and recovery-attempt state.
4. Bind decisions to task and enablement generations.
5. Put the live enabled-state guard first in notification-decision paths.
6. Keep timer cleanup and static registration independent of that guard.

### Phase 2: integrate tool decisions and boundaries

1. Validate checkpoint identifiers and action-specific arguments.
   Require identifiers for outcomes; implement atomic proactive attention decisions with explicit tool or plan-review targets. Canonicalize targets and preserve identity across resubmission without using dispatch IDs as semantic identity.
2. Resolve a speak checkpoint only after queue acceptance.
3. Resolve a silent checkpoint without synthesis or playback.
4. Make duplicate decisions idempotent.
5. Coalesce related outcome candidates and keep attention boundaries distinct.
   Implement the pre-wait path table for questions, approvals, authentication, and both tool-launched and native plan review. Confirm actual waits without duplicating approval policy. Record immediate unresolved status where no safe recovery point exists; do not create a model turn inside a pending wait.
6. Request missing decisions once through existing OMP APIs.
7. Mark unresolved failure after recovery, without blocking the task or question indefinitely.
8. Add compact text-only unresolved status without another model turn.
9. Preserve first-check enablement, primary-only behavior, and ordinary empty-response recovery.

### Phase 3: deterministic and runtime verification

Permanent tests must cover user-visible invariants and transitions, not wording or source text.

Run:

```sh
bun test --isolate
bun run typecheck
```

Run these from `plugins/speak-notifications` in the worktree. Exercise the actual changed OMP path after tests. A scripted provider can prove checkpoint transitions and bounded failure; it cannot prove autonomous model judgment or audio playback.

Exercise proactive attention followed by its matching `ask`, approval-triggering call, and plan review; proactive outcome followed by settlement; changed targets; and retry dispatch IDs. Verify one decision and no duplicate queue acceptance for matching targets. Exercise omitted decisions at intercepted boundaries and uncovered approvals or native reviews. The latter must leave the prompt available, record unresolved status without recovery, and start no repair turn while waiting or afterward.

Use real-model scenarios whose task prompts do not request speech or name the notification tool. Test more than one available model/backend family where credentials permit. Do not add provider-specific production branches to make a test pass.

Report separately: model decision, queue acceptance, completed playback, and unresolved notification. A real model that omits a decision must pass the bounded-failure scenario, not count as successful notification use.

### Phase 4: documentation and handoff

1. Synchronize the existing specification, README, and changelog with this contract.
2. Keep the version source in `package.json`; do not duplicate it in the catalog.
3. Preserve the existing unshipped `0.4.0` version unless intervening release history requires another bump.
4. Remove temporary verification scripts after preserving sanitized evidence.
5. Run `bun scripts/validate-marketplace.ts` from the worktree root.
6. Report only exercised checks and unresolved model-compliance limits.
7. Leave commits, installation, and PR creation to explicit user direction.

## Acceptance checklist

- [ ] Live enabled state is the first notification-decision check.
- [ ] Disabled sessions create no candidates, checkpoints, consumed reminders, recovery requests, or audio.
- [ ] Primary-only registration and decisions survive ordinary internal continuations.
- [ ] Speak and silent decisions resolve only their matching checkpoint.
- [ ] Invalid, rejected, duplicate, and stale decisions do not cause duplicate audio or false completion.
- [ ] A proactive outcome decision with the current identifier covers matching settlement without another request or audio.
- [ ] A targeted proactive attention decision covers only the matching question, approval, or unchanged plan review.
- [ ] Repeated target decisions and resubmissions with new dispatch IDs neither duplicate audio nor restart recovery; changed targets receive distinct checkpoints.
- [ ] Progress does not suppress a final-outcome checkpoint.
- [ ] Related background results share one checkpoint; unrelated questions do not share decisions.
- [ ] Recovery runs at most once per checkpoint, remains distinct from resolution, and records zero attempts when no safe recovery point exists.
- [ ] Failed recovery produces explicit unresolved status without a fabricated decision.
- [ ] Questions and task results remain available after unresolved notification failure.
- [ ] Approval, authentication, and tool-launched or native plan-review paths validate exact proactive coverage before claiming notification success.
- [ ] Safe pre-wait recovery runs at most once; an uncovered wait with no safe recovery point records unresolved status with no automatic audio or repair turn and keeps its prompt available.
- [ ] Idle context inspection cannot consume checkpoint or timer instructions.
- [ ] Context size stays bounded without copied notification history or a separate judge.
- [ ] Countdown runs during background work while the primary is idle.
- [ ] Idle without jobs, overlapping user waits, and speech preserve the remaining countdown.
- [ ] Successful playback resets it; expiry and queue acceptance do not imply playback success.
- [ ] Timer expiry never wakes an idle agent or requires speech.
- [ ] Off, cancellation, resume, and shutdown invalidate old checkpoint work.
- [ ] Real OMP demonstrates both valid decisions and bounded unresolved behavior without provider-specific logic.
- [ ] Plugin tests, typecheck, marketplace validation, and actual runtime smoke have observed evidence.

## Non-goals

No provider adapter changes, native forced-tool requests, automatic final-answer reading, per-tool notifications, separate model classifiers, persisted notification history, or unlimited continuation loops.

The empty-response issue is a separate work stream. Do not modify its provider translation, retry, or settlement behavior in this task.

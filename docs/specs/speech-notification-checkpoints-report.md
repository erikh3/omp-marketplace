# Speech notification checkpoints report

## Current state

The unshipped `speak-notifications` plugin is version `0.4.1` on branch `speech-decision-reminders`, following review of draft PR #63 at `8f8807b60543460a6888c47a69ad1931be35095f`. All six confirmed review defects are corrected. The fresh real-model smoke exercised the corrected source directly without installing or linking it. The code fixes passed deterministic verification, but the smoke did not establish reliable notification significance judgment. Do not treat this report as release approval.

Speech remains session-local, primary-only, and disabled by default. Queue acceptance is decision coverage, not proof that a human heard the notification.

## Corrected review defects

| Defect | Correction | Evidence |
| --- | --- | --- |
| Nested device cleanup restarted attention recovery | Outer completion retains a blocked inner target; a later accepted or released inner boundary is tracked for actual consumption | Registered regressions and fresh `write xd://ask` interaction |
| Optional outcome metadata hid and consumed expired timers | Required outcome takes precedence, then due timer, then optional identity; only an injected active-turn timer instruction is consumed | Deterministic active-turn and idle-inspection regressions |
| Automatic abort retry invalidated task coverage | Aborted `agent_end` invalidates only when the host is not continuing | Pending-coverage continuation and terminal-cancellation regressions |
| Background candidate state crossed user tasks | New-task reset clears `backgroundResultPending` | Async-result/new-routine-task regression; fresh background task followed by silent quick lookup |
| Consumed unresolved checkpoints exhausted admission | Retire consumed or superseded unresolved objects while preserving aggregate failure count and no accepted tombstones | More than 16 sequential unresolved attention and outcome regressions |
| Unresolved silent decision falsely reported acceptance | Reject unresolved silence with `isError` and no playback | Registered unresolved-attention regression |

Pending timer reads also include active time since expiry without consuming the reminder.

## Deterministic verification

Run from the plugin directory unless stated otherwise:

```text
bun test --isolate                  87 pass, 0 fail
bun run typecheck                   passed
bun scripts/validate-marketplace.ts passed from worktree root
```

The regressions use real registered tool schema validation and deterministic clocks. No production classifier, provider branch, automatic speech, or final-answer reader was added.

## Fresh driven OMP smoke

Date: 2026-11-04. OMP 18.16.0. Model: `hai-anthropic/anthropic--claude-4.6-sonnet`.

The primary agent created Herdr tab `w1R:t8`, pane `w1R:pN`, with named test agent `speech-smoke-pr63`. `/speak on` ran at 20:00:48 UTC before the first task at 20:01:07 UTC. The launch used explicit corrected extension and passive event-recorder paths with ambient extensions, skills, rules, context files, and LSP discovery disabled. No speech instructions were inserted into the natural implementation, lookup, missing-data, background, or release-decision task prompts. The nested transport scenario explicitly requested `write xd://ask` to exercise the reviewed transport defect.

Session ID: `01a1a826-2d09-73d3-80e2-4752a984943f`.

Local evidence:

```text
/tmp/pr63-speech-smoke-20261104/session/2026-11-04T20-00-36-617Z_01a1a826-2d09-73d3-80e2-4752a984943f.jsonl
/tmp/pr63-speech-smoke-20261104/events.jsonl
/tmp/pr63-speech-smoke-20261104/source-identity.txt
```

These local artifacts may expire. They are not required to understand or resume the implementation. Do not publish raw event or session records.

### Observed behavior

| Scenario | Written result | Notification behavior | Assessment |
| --- | --- | --- | --- |
| Build and run summarizer | Correct totals: INFO 3, WARN 1, ERROR 3, orders 5, health 2, alpha 4, beta 3, DB_TIMEOUT 2 | One accepted outcome | Notification passed; final prose overclaimed the fault domain and equated settlements with regions |
| Quick route lookup | `/orders`, count 5 | No notification | Passed |
| Substantial missing-region investigation | Identified no region field, but still proposed settlement as a geographic proxy | No notification or explicit silence | Notification acceptance failed; data interpretation also failed |
| Duplicate-policy question | Choice UI opened; driver selected `Discard exact duplicates`; implementation ran | Initial invalid call supplied both ID and boundary; a revised target got a new attention ID; valid silent recovery preceded the question; one completion outcome | Validation and recovery worked; silence reflected model significance judgment |
| Awaited background stability check | Five runs produced identical totals, reported PASS | One accepted outcome after the wait returned | Passed |
| Quick lookup after background work | `2` | No notification or forced recovery | Passed |
| Material release decision | Asked hold versus settlement-only reporting; session recorded `Hold`; wrote fixture release decision | Proactive speech queued for a different question target, actual question used a valid silent recovery, then one hold outcome | Exact-target validation worked; proactive speech did not cover the changed question |
| Nested `write xd://ask` | Choice UI opened; driver selected `audit-b.txt`; model returned the filename | Outer-boundary silence did not cover inner ask; one block supplied `speech-8-2-14`; recovery silence accepted; unchanged nested retry executed under a new dispatch ID | Reviewed nested defect fixed; routine filename completion was unnecessarily spoken |
| Speech off and one summarizer run | Totals unchanged | No notification attempts | Passed |

At 20:06:05 UTC, `/speak status` reported playback idle, waiting `0/3`, unresolved `0`, local model `kokoro`, voice `af_heart`, speed `1.2`, and no retained playback error. The earlier duplicate-policy task did emit one unresolved notice after its recovery decision was omitted for the original target. New-task reset explains the later zero count; it is not proof that no unresolved boundary occurred.

Across the smoke, six speak decisions and four silent decisions were accepted, and one speak decision was rejected for supplying both identifier and boundary. That aggregate is not a success rate: the missing substantial notification and unnecessary routine notification remain failures.

The driver sent the duplicate-policy and nested filename fixture selections. The release-hold selection was recorded by OMP, but this driver sent no selection for that dialog, so its external actor is not established here.

The implementation task emitted two empty terminal responses and an extra final completion acknowledgement after its valid outcome. The model's thinking treated transient speech metadata as the current user request. These are observed output-quality failures, not a confirmed new production-code cause.

The smoke agent shut down at 20:09:37 UTC after speech was switched off. Its tab history remains available. Other agents were left untouched.

### Source identity

Corrected production files were frozen before launch. SHA-256 fingerprints:

```text
18fc7b48b7a34882601fb1ef77c04fe3bcc66de15112c6b6d866167673354b06 src/index.ts
c60148b531273ddef2053e3e8e1fad962811085f72dc7e40dc56e1a977400d4b src/checkpoints.ts
e3dcbc811755f575854d8f251ee78d7fb5a18f10ef89cc22956013342013dd23 src/reminder-clock.ts
97c5caab0824f6593678fe2286fdd56be8bf297338d0720b7a9afb781328c859 src/guidance.ts
a2814fb76366cb81480872676d1443b425411bcdfc98c1293e438c4c772b92aa src/controller.ts
ed8404103e796022d8d8fa11a2b22a10e8dc44ee58df6444ba1ff25ad63d8fea src/playback.ts
```

## Verification limits

- Real speech queue acceptance and later idle status were observed. Human audibility was not verified. No synthesis error was recorded in the observed status, but it does not individually prove each later playback completed.
- Timer expiry, repeated unresolved-capacity pressure, and automatic abort ownership were exercised deterministically, not forced inside the real-model session.
- The background smoke awaited the job through `wait`; the dedicated regression covers an `async-result` message followed by a new task.
- Real nested ask recovery succeeded. No live Plannotator review window or native approval dialog was opened in this smoke.
- The model can omit significant notifications, choose inappropriate silence, announce routine results, change targeted arguments, or answer transient metadata. Validation does not guarantee tool selection or correct judgment.
- Approval and native plan-review waits can lack a safe recovery turn. Uncovered waits remain unresolved without closing or delaying their host prompts.
- Ordinary empty-response recovery and provider translation remain outside this change.

## Earlier evidence

The pre-review v2 Sonnet matrix showed accepted implementation and one-read outcomes, routine lookup silence, attention recovery after invalid IDs, and an extra metadata-related acknowledgement. It did not capture loaded source fingerprints or establish playback completion. The new smoke above supersedes that evidence for the corrected source and does not claim uniformly successful model behavior.

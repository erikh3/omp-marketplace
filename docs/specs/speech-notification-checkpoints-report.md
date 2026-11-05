# Speech notification simplification report

## Historical evidence only

The earlier checkpoint prototype is historical evidence only. The current `0.5.0` implementation and its verification are recorded below. Neither smoke is release approval or a guarantee of correct model significance judgment.

The prototype used checkpoint IDs, attention boundaries, silent decisions, recovery, unresolved status, and timer assessments. Those mechanisms are superseded. See the [current specification](speak-notifications-specification.md) and the [superseded checkpoint plan](speech-notification-checkpoints-plan.md).

## Previous real-model smoke

On 2026-11-04, a real-model smoke exercised unshipped `0.4.1` source directly without installing or linking it. It used OMP 18.16.0 with `hai-anthropic/anthropic--claude-4.6-sonnet`.

The smoke observed accepted speech decisions, silent decisions, queue behavior, and no notification attempts after speech was disabled. It also observed missed substantial notifications, unnecessary routine notifications, invalid targeting, and metadata-related output-quality failures. It did not establish reliable significance judgment, human audibility, or completed playback for each accepted queue item.

Previous deterministic results and source fingerprints applied only to that checkpoint prototype. They must not be treated as results for the current design.

## Current verification

The current implementation passed `bun test --isolate` with 57 passing tests, `bun run typecheck`, and marketplace validation. Deterministic regressions cover the inclusive five-minute milestone boundary, outcome and attention bypass, normalized duplicate suppression, rejection without consuming gates, new-task state, disable/resume reset, and retained local playback ownership.

The primary agent drove a fresh OMP 18.16.0 Sonnet session on 2026-11-05 using the explicit worktree extension without installing it. Herdr tab `w1R:tA`, pane `w1R:pQ`, agent `speech-simple-smoke`. Speech was enabled before the first task.

| Scenario | Observed result |
| --- | --- |
| Natural implementation task | Built and ran the summarizer, gave correct totals, and queued one original agent-authored outcome sentence |
| Routine route lookup | Returned orders and count 5 with no speech |
| Material release question | Question opened immediately without recovery or interference, but the model omitted attention speech |
| Explicit delivery-only frequency test | Early milestones were suppressed; an outcome bypassed spacing; no suppressed call was retried |
| Explicit delivery-only duplicate test | First outcome queued; identical attention text was suppressed; a different attention sentence queued immediately |
| Speech status | Playback idle, queue empty, local Kokoro voice and speed displayed, no retained error |
| Speech off | Summarizer ran and returned unchanged totals without speech |

All spoken messages were supplied by the model, not by host templates. The delivery-only tests requested tool calls explicitly and therefore prove runtime gates, not autonomous trigger selection. The natural implementation and quick-lookup prompts did not request speech. No fake notification decisions, question blocks, timer requests, or notification-only recovery turns occurred. The model still omitted the material attention notification; this is a best-effort tool, not enforced audio compliance. Its written incident conclusion overclaimed an outage from the small fixture; speech text itself reported the observed counts.

Local evidence, which may expire:

```text
/tmp/speech-simple-smoke-20261105/events.jsonl
/tmp/speech-simple-smoke-20261105/session/2026-11-05T09-55-01-623Z_01a1ab22-1b77-721f-94cb-673342cefa59.jsonl
```

The loaded source was fingerprinted before launch:

```text
e63b4cc48586006717ad770c762e49c4200028638947c60a3c81344e8096985e src/index.ts
c974867a4dcd7f0050792efa0ef4d6835a882f51cddb0005e8a1d4a1ad1d57a3 src/guidance.ts
```

The smoke agent was stopped after speech was disabled; its tab history remains available. Human audibility was not verified. Per-item successful playback was not claimed from queue acknowledgement. No global installation, automatic assistant speech, provider configuration, or speech-to-text setting changed.

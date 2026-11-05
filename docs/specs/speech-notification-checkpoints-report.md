# Speech notification simplification report

## Historical evidence only

The earlier checkpoint prototype and the `0.5.0` smoke are historical evidence only. They do not verify the current `0.6.0` queue-priority and milestone-supersession behavior. Neither smoke is release approval or a guarantee of correct model significance judgment.

The prototype used checkpoint IDs, attention boundaries, silent decisions, recovery, unresolved status, and timer assessments. Those mechanisms are superseded. See the [current specification](speak-notifications-specification.md) and the [superseded checkpoint plan](speech-notification-checkpoints-plan.md).

## Earlier smoke evidence

The 0.4.1 checkpoint smoke on 2026-11-04 and 0.5.0 simplified-tool smoke on 2026-11-05 applied only to those versions. The simplified smoke verified original agent-authored outcome text, routine lookup silence, frequency and duplicate suppression, and disabled behavior. A material user question still omitted speech. Neither version guaranteed correct significance judgment or human audibility.

## 0.6.0 feature verification

The current source passed 66 tests, typecheck, and marketplace validation. Controlled-playback tests covered attention priority, FIFO within priority, active playback protection, full-queue milestone replacement, task isolation, atomic rejection, and absence of playback callbacks for superseded items. Registered-tool tests exercised the same behavior through the unchanged text-and-purpose schema and internal task counter.

The primary agent drove an OMP 18.16.0 Sonnet delivery-only smoke in Herdr tab `w1R:tB`, pane `w1R:pR`. The production plugin was loaded explicitly without installation. A throwaway observer accelerated the admission clock so multiple milestones could be accepted without five-minute sleeps. Actual local TTS and playback were unchanged. A PATH-scoped observer logged the start and exit of real OMP speech subprocesses. No global settings or installations changed.

The successful session was `01a1ad05-326e-709e-9950-7c8c23e2d8de`. Speech was enabled before its task. Every message was authored by the model. The first long message kept playback active while a second outcome, a milestone, and attention were queued.

| Observation | Evidence |
| --- | --- |
| Active speech uninterrupted | First speech ran from 18:44:16.436 to 18:44:49.087 UTC and exited with code 0 |
| Attention played next | Attention started at 18:44:49.129 UTC, before the earlier waiting outcome, and exited with code 0 |
| Ordinary outcome retained | Earlier waiting outcome started at 18:44:56.803 UTC and exited with code 0 |
| Latest progress replaced prior waiting progress | The next task's first milestone reported the previous task's waiting milestone as superseded; a second milestone then superseded the first |
| Final outcome cleared its task's queued progress | The final outcome reported the second milestone as superseded and was the next ordinary item to play |
| Removed progress never played | No speech process start existed for any of the three superseded milestone texts |
| Final queue drained | Final outcome exited with code 0 at 18:45:16.519 UTC; `/speak status` reported idle playback, waiting 0/3, and no retained error |

An earlier observer launch failed because its restricted PATH lacked Bun. The driver repaired the throwaway observer and started a fresh session. That failed run is not counted as playback proof. In the successful run, an over-500-code-point message was rejected; the model shortened it before queue acceptance. Model-authored fixture messages contained unsupported success claims, so their prose is not evidence of work completion. These explicit delivery tests prove ordering and supersession, not autonomous notification judgment or human audibility.

Local evidence, which may expire:

```text
/tmp/speech-queue-smoke-20261105/events.jsonl
/tmp/speech-queue-smoke-20261105/playback.jsonl
/tmp/speech-queue-smoke-20261105/session/2026-11-05T18-42-41-390Z_01a1ad05-326e-709e-9950-7c8c23e2d8de.jsonl
```

Loaded production source fingerprints:

```text
5933ef953468fe99270590f8f19a609ff4d6a35a255702751f5d5741b945f7ca src/controller.ts
ed3c813943844d0801c1722231ff3af4bc18e4d56116916489381dafcc387f8e src/index.ts
1cebe1a27a70cf096a92f29181805f0738df35a3082b99c228cd99f2c7d8aa83 src/guidance.ts
```

The smoke runtime was stopped after its speech queue drained. Tab history is retained. The five-minute admission gate was exercised with deterministic time in tests and an accelerated clock in this smoke. Cross-task outcome preservation was verified deterministically rather than inferred from the final task's supersession.

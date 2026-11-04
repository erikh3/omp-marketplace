# Speech notification checkpoints report

## Current state

The unshipped `speak-notifications` plugin remains at version `0.4.0` on branch `speech-decision-reminders`. This report covers the current implementation prepared for a draft pull request. It was not installed or linked.

The implementation keeps speech session-local and disabled by default. The primary agent has one registered `speak_notification` tool. It records `speak` or `silent` decisions for outcomes, attention boundaries, and milestones. Local TTS, the FIFO worker, cancellation, cooldown, and existing command behavior remain unchanged.

## Checkpoint behavior

- Checkpoints bind to the current task and enablement generations.
- A first enabled work result makes a current task outcome ID available. The ID is optional and only valid for `purpose: "outcome"`.
- Existing candidate thresholds still decide when an outcome becomes required. A successful write or edit, three work results, one minute of work, or relevant background work promotes the same outcome ID to required coverage. The promotion does not replace the ID.
- A required outcome gets one bounded recovery at settlement. Optional routine work gets neither a required decision nor recovery.
- Attention uses either an exact active-tool boundary or an attention ID that the plugin requested. Outcome IDs cannot satisfy attention decisions. A purpose mismatch returns an actionable error without audio coverage.
- Tool identity ignores only top-level OMP `i` intent metadata. All other top-level execution arguments remain part of the target.
- An intercepted `ask` records its preflight `tool_execution_start` as the original blocked dispatch. The next model response can decide. If it omits a decision, the next same-target question becomes unresolved and opens instead of receiving a second recovery block.
- Live state remains a per-request developer instruction. It is phrased as metadata and tells the agent to answer the user rather than the note. This latest wording has deterministic coverage only.

## Interactive OMP evidence

The completed v2 Sonnet matrix provided these observed results:

- The build task produced its textual result and queued one accepted outcome notification.
- The routine quick lookup stayed silent.
- The substantive one-read missing-region investigation gave its textual conclusion before it queued one accepted outcome notification.
- The prior attention expiry defect was fixed. After an ID-less attention attempt, the question blocked, the next model response supplied `speech-4-2-2`, speech queued, and the same question opened under a new dispatch ID.
- In a later attention case, the model used the optional outcome ID as an attention ID twice. Both calls were correctly rejected. It then used a plugin-requested attention ID and queued speech before the user choice opened.
- After the valid negative outcome, the model emitted an extra `No active task to continue: investigation complete before this message arrived.` The task result was already present. This is an output-quality issue. The current passive metadata wording was added after the matrix and has not received another real-model run.

The earlier corrected session also showed one accepted substantial outcome and a silent routine lookup. Its original immediate attention expiry was caused by OMP emitting `tool_execution_start` for the call blocked by `tool_call`, not by model noncompliance.

## Deterministic verification

The current source passed:

```text
bun test --isolate                 81 pass, 0 fail
bun run typecheck                  passed
bun scripts/validate-marketplace.ts passed
bun test --isolate test/registered-tool.test.ts 18 pass, 0 fail
```

The registered-tool suite covers current-ID outcome acceptance after one work result, optional-to-required promotion without changing the ID, outcome-versus-attention mismatch rejection, accepted recovery decisions after a blocked preflight call, and release after one omitted recovery response.

## Known limits

- Queue acceptance confirms coverage only. It does not prove playback completed.
- The v3 passive metadata wording and the latest purpose guidance have deterministic coverage but no later real-model verification.
- Models can still issue invalid tool calls. The plugin rejects invalid, stale, mismatched, and queue-rejected decisions. It does not force tool use, manufacture speech, parse final answers, or add provider-specific request handling.
- Approval and native plan-review waits may have no safe model-decision turn. The plugin keeps those host prompts available and records uncovered waits as unresolved.
- The empty-response problem belongs to a separate work stream.

## Files changed for this task

```text
docs/specs/speak-notifications-specification.md
docs/specs/speech-notification-checkpoints-plan.md
docs/specs/speech-notification-checkpoints-report.md
plugins/speak-notifications/CHANGELOG.md
plugins/speak-notifications/README.md
plugins/speak-notifications/package.json
plugins/speak-notifications/src/checkpoints.ts
plugins/speak-notifications/src/controller.ts
plugins/speak-notifications/src/guidance.ts
plugins/speak-notifications/src/index.ts
plugins/speak-notifications/src/reminder-clock.ts
plugins/speak-notifications/test/checkpoints.test.ts
plugins/speak-notifications/test/command.test.ts
plugins/speak-notifications/test/completion.test.ts
plugins/speak-notifications/test/registered-tool.test.ts
plugins/speak-notifications/test/reminder-clock.test.ts
```

# sse-stream-retry

Auto-continues the current OMP turn when the model stream aborts with an SSE iteration error, so the agent recovers instead of stopping.

## Behavior

When a turn ends with `stopReason: "error"` and the error text matches `Error while iterating over SSE stream` (the aborted-stream family), the plugin injects a `.` (continue) message to resume the agent.

Retries escalate, then stop:

| Attempt | Delay |
| --- | --- |
| 1 | immediate |
| 2 | 1s |
| 3 | 3s |
| 4 | 5s |
| 5 | 10s |

After the fifth consecutive abort it gives up and reports the failure instead of looping. Any recovered (non-error) turn restarts the sequence from the beginning, so an isolated abort later in the session gets the full immediate-first ladder again.

## Configuration

| Setting | Default | Purpose |
| --- | --- | --- |
| `enabled` | `true` | Enables auto-continue on aborted SSE streams. |

## Boundaries

- Matches only the SSE iteration abort. Other error stop reasons pass through untouched.
- Provider-agnostic: the abort is transport-level, so there is no endpoint restriction.
- A `.` continue cannot recover a turn whose failure is not transient; the give-up path exists for that case.

## Development

```bash
bun test
bun run typecheck
```

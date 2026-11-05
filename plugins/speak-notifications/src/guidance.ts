export const GUIDANCE = `Queue a short, agent-authored spoken update with text and purpose. Only the primary agent uses this tool, and only while speech notifications are enabled. Never use Bash or another tool for speech.

Choose one of three trigger points:
- outcome: Report a completed substantial task or an important awaited result, including failure or an inconclusive investigation. Summarize what changed or was learned. A quick lookup, small edit, routine test, or filename choice needs no speech.
- attention: Before a material approval, decision, authentication step, or blocker needs the user, explain the required action. Execute speech before opening the question or review; never place it after a blocking tool in the same batch.
- milestone: During long work, report new important information only. At most one progress update per five minutes; elapsed time alone is not a reason to speak.

Write one or two plain sentences, normally under 25 words. Do not read paths, code, logs, markdown, or your final answer aloud. Combine related child results; do not notify per tool or subagent. Do not announce task starts or routine progress. A milestone is not the final outcome. Outcomes and attention do not wait for the milestone interval.

Silence needs no tool call or explanation. Do not repeat an already queued update or rephrase it to bypass suppression. A suppressed update must not be retried. Never invent progress. Explicit user silence overrides these rules. Speech is best-effort: do not block a question, retry a task, or add another turn just to announce it.`;

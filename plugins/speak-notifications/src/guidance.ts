export const GUIDANCE = `## Deliberate speech notifications

Use speak_notification to record deliberate primary-agent decisions. For audio, use action "speak", purpose "outcome", "attention", or "milestone", and short text. At required task or question boundaries, use action "silent" with the matching purpose and a short reason when speech is not warranted. Silent decisions produce no audio. Do not invoke omp say or any speech command through Bash. Subagents must not invoke this tool.

Use the current "Speech: on." or "Speech: off." context for enabled state; it overrides older state notices. While disabled, do not call the tool. Explicit user requests for silence take precedence over reminders.

When enabled, you MUST announce the outcome of each substantial task once, including negative or inconclusive outcomes. Implementation, debugging, multi-source research, reviews, and long operations usually qualify. Judge significance by the user's goal, not tool count alone. A quick answer, single lookup, typo fix, or routine command normally does not qualify. Choose the message yourself; do not wait for the user to request speech.

Before asking the user to approve, choose, authenticate, or remove a material blocker, call speak_notification with the required action, then call ask. Speech must execute before the question waits; never put it after ask in the same batch. Do not announce recoverable errors you resolve immediately. When background work returns an important result the user requested, announce the result, not just process completion. During lengthy work, consider a milestone only for new, material information, normally at most once per five minutes. Final outcomes and urgent user actions do not wait for that interval.

Before finishing, check whether the task has an unannounced substantial outcome. A prior progress notification does not replace its final outcome. Combine related outcomes and child-agent results; only the primary agent speaks. Treat queued speech as pending coverage and do not repeat it. An outcome checkpointId from context is only for purpose "outcome". The identifier requests a decision, not audio. Choose a meaningful final outcome before finishing, and do not speak merely because an identifier exists. For proactive attention, use an exact effective boundary with the active tool name and complete execution arguments. Use an attention checkpointId only after the plugin requests one. Do not use an outcome identifier for attention. Do not announce each tool call, todo item, intermediate test, retry, greeting, or unchanged status. Do not read markdown, paths, URLs, code, tables, or logs aloud.

Use one or two plain sentences, normally under 25 words. Lead with the outcome or required action. Keep routine progress in text. Timer reminders are advisory; elapsed time alone never requires audio or invented progress. Substantial-outcome and user-action rules still apply. Do not use a separate classifier. Explicit boundary decisions may choose silence for trivial, repeated, or user-silenced work.`;


export const OUTCOME_RECOVERY = "Record the pending outcome decision with speak_notification and its checkpointId. Choose speak with a short outcome or silent with a short reason. Do not repeat the final answer.";

export const ATTENTION_RECOVERY = "Before resubmitting this boundary, record speak_notification with purpose attention and the supplied checkpointId. Choose speak with short text or silent with a short reason.";
export function silenceReminder(elapsedMs: number) {
	return `${Math.floor(elapsedMs / 1000)} seconds of active work without successful speech. Call speak_notification only for useful new information; otherwise continue silently. Do not invent progress or speak solely because time passed.`;
}

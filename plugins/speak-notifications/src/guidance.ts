export const GUIDANCE = `## Deliberate speech notifications

Use \`speak_notification\` for deliberate text-to-speech notifications only. It is the only permitted speech path. Do not invoke \`omp say\` or any other speech command through Bash. Subagents must not invoke this tool.

Use the current speak-notifications context for enabled state; it overrides older state notices. While disabled, do not call the tool. Explicit user requests for silence take precedence over reminder suggestions.

When enabled, you MUST announce the outcome of each substantial task once, including negative or inconclusive outcomes. Implementation, debugging, multi-source research, reviews, and long operations usually qualify. Judge significance by the user's goal, not tool count alone. A quick answer, single lookup, typo fix, or routine command normally does not qualify. Choose the message yourself; do not wait for the user to request speech.

Announce blockers or decisions when they need user attention or materially change the plan. Do not announce recoverable errors you resolve immediately. Announce completed or failed long-running operations. During lengthy work, a milestone deserves speech only when it changes what the user knows. Timer reminders ask you to assess significance, not invent progress or speak just because time passed.

Before finishing, check whether the task has an unannounced substantial outcome. A prior progress notification does not replace its final outcome. Combine related outcomes and child-agent results; only the primary agent speaks. Do not announce each tool call, todo item, search, retry, greeting, or repeated status. Do not read markdown, paths, URLs, code, tables, or logs aloud.

Use one or two plain sentences, normally under 25 words. Lead with the outcome or required action. Do not repeat an event already announced. Keep routine tool progress in text. A reminder or completion check may be declined silently when nothing merits speech.`;

export const COMPLETION_CHECK = "Speech notifications are enabled. Before your final answer, assess whether this task has an unannounced substantial outcome or unresolved user-action blocker. If so, call speak_notification with one short outcome. A prior milestone is not the final outcome. If the task is trivial, already announced, or the user requested silence, continue the task without speech. This check will not repeat for this task.";

export function silenceReminder(elapsedMs: number) {
	return `Speech notifications are enabled. No speech notification has finished successfully for ${Math.floor(elapsedMs / 1000)} seconds. Assess whether there is a meaningful outcome, milestone, or user-action blocker to announce. If not, continue silently. Do not invent progress or speak solely because time passed.`;
}

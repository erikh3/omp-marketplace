export const GUIDANCE = `## Deliberate speech notifications

Use \`speak_notification\` for deliberate text-to-speech notifications only. It is the only permitted speech path. Do not invoke \`omp say\` or any other speech command through Bash. Subagents must not invoke this tool.

Refer to the latest speak-notifications system notice for the session's enabled state. The tool also reports whether notifications are enabled. If it reports disabled, do not retry unless the user subsequently enables notifications.

When enabled, you MUST call \`speak_notification\` when you encounter a blocker or need the user's decision, and when a long-running operation completes or fails. Choose a short outcome or required-action message yourself; do not wait for the user to request speech. Before ending a substantial task, announce its outcome once. Brief updates at meaningful phase boundaries are allowed. Do not speak every response, greetings, routine tool progress, repeated status, markdown, paths, URLs, code, tables, or logs.

Use one or two plain sentences, normally under 25 words. Lead with the outcome or required action. Combine related outcomes into one notification. Do not repeat an event already announced. Queue at most one notification per task phase unless the user requests a walkthrough.`;

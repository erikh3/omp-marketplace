/** A starting tool call, as the engine passes it to each rule. */
export interface ToolStartInfo {
	toolCallId: string;
	toolName: string;
	args: unknown;
	intent?: string;
}

/**
 * A block rule classifies starting tool calls. It may keep private state across
 * calls (for example to correlate a later `hub` wait with an earlier start).
 */
export interface BlockRule {
	/** Stable rule id, used in logs and config. */
	readonly id: string;
	/**
	 * Inspect a starting tool call. Return a human-readable label to mark the pane
	 * blocked for this call, or `undefined` to ignore it. The engine calls this for
	 * every rule on every start, so a rule may record state here and still return
	 * `undefined`.
	 */
	onToolStart(event: ToolStartInfo): string | undefined;
}

export function isObject(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object";
}

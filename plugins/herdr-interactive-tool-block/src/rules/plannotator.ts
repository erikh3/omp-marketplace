import { isObject, type BlockRule } from "./types.ts";

/** A `plannotator review` or gated `plannotator annotate` bash command. */
function isPlannotatorCommand(args: unknown): boolean {
	if (!isObject(args)) return false;
	const command = args.command;
	return (
		typeof command === "string" &&
		/^\s*(?:env\s+(?:[A-Za-z_][A-Za-z0-9_]*=[^\s]+\s+)*|command\s+)?plannotator\s+(?:review(?:\s|$)|annotate\b(?=[\s\S]*\s--gate(?:\s|$)))/.test(
			command,
		)
	);
}

/** The session name if `args` starts a plannotator hub session, else `undefined`. */
function plannotatorHubStartName(args: unknown): string | undefined {
	if (!isObject(args)) return undefined;
	if (args.op !== "start" || args.application !== "plannotator") return undefined;
	return typeof args.name === "string" ? args.name : undefined;
}

function isPlannotatorHubWait(args: unknown, sessions: ReadonlySet<string>): boolean {
	if (!isObject(args) || args.op !== "wait" || typeof args.name !== "string") return false;
	return sessions.has(args.name) || args.name.startsWith("plannotator");
}

/**
 * Blocks for the full lifetime of interactive Plannotator plan and code review
 * commands, so the pane reads as awaiting human review. Tracks hub sessions
 * started with `application=plannotator` and blocks on a later wait for one, and
 * blocks directly on a `plannotator review`/gated `annotate` bash command. Ported
 * from the standalone `plannotator-herdr-blocked` extension.
 */
export function plannotatorRule(): BlockRule {
	const sessions = new Set<string>();
	return {
		id: "plannotator",
		onToolStart(event) {
			if (event.toolName === "bash") {
				return isPlannotatorCommand(event.args) ? "plannotator review" : undefined;
			}
			if (event.toolName !== "hub") return undefined;
			const startedName = plannotatorHubStartName(event.args);
			if (startedName !== undefined) {
				sessions.add(startedName);
				return undefined;
			}
			if (isPlannotatorHubWait(event.args, sessions)) return "plannotator review";
			return undefined;
		},
	};
}

/** Rule module entry. */
export default plannotatorRule;

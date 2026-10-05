import { isObject, type BlockRule } from "./types.ts";

/**
 * A difit launch bash command: `difit ...` or `npx difit ...`, optionally behind
 * an `env VAR=... ` or `command ` prefix. difit opens a browser diff viewer and
 * blocks the agent until the human finishes, like a review gate.
 */
function isDifitCommand(args: unknown): boolean {
	if (!isObject(args)) return false;
	const command = args.command;
	return (
		typeof command === "string" &&
		/^\s*(?:env\s+(?:[A-Za-z_][A-Za-z0-9_]*=[^\s]+\s+)*|command\s+)?(?:npx\s+)?difit(?:\s|$)/.test(command)
	);
}

/**
 * Blocks while this agent waits on a difit review. Matches a `difit`/`npx difit`
 * launch bash command, and the legacy `hub(op="wait", name="difit")` form for
 * setups that still route difit through a background hub session.
 */
export function difitRule(): BlockRule {
	return {
		id: "difit",
		onToolStart(event) {
			if (event.toolName === "bash") {
				return isDifitCommand(event.args) ? "difit review" : undefined;
			}
			if (event.toolName !== "hub") return undefined;
			const args = event.args;
			if (!isObject(args)) return undefined;
			if (args["op"] !== "wait" || args["name"] !== "difit") return undefined;
			return "difit review";
		},
	};
}

/** Rule module entry. */
export default difitRule;

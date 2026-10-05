import { isObject, type BlockRule } from "./types.ts";

/**
 * A blocking `remote-shell` bash command: `send-text` stages a command in the
 * neighboring remote pane and waits for the human to press Enter, and
 * `wait-output` blocks until the human submits and the command completes. Both
 * wait on the user, so the pane should read as blocked for their whole lifetime.
 * The other subcommands (`layout`, `select`, `read`, `reset`, `dismiss-pager`)
 * return promptly and never wait on the user, so they are not matched.
 *
 * An optional `env VAR=... ` or `command ` prefix is tolerated, matching the
 * other bash rules.
 */
function isRemoteShellWait(args: unknown): boolean {
	if (!isObject(args)) return false;
	const command = args.command;
	return (
		typeof command === "string" &&
		/^\s*(?:env\s+(?:[A-Za-z_][A-Za-z0-9_]*=[^\s]+\s+)*|command\s+)?remote-shell\s+(?:send-text|wait-output)(?:\s|$)/.test(command)
	);
}

/**
 * Blocks while this agent waits on a `remote-shell` command. The remote-shell
 * skill drives a neighboring remote pane one command at a time, where the human
 * alone presses Enter to submit each staged command. `send-text` and
 * `wait-output` therefore block the agent on the user mid-execution, which is
 * exactly what this plugin reports to Herdr.
 */
export function remoteShellRule(): BlockRule {
	return {
		id: "remote-shell",
		onToolStart(event) {
			if (event.toolName !== "bash") return undefined;
			return isRemoteShellWait(event.args) ? "remote shell" : undefined;
		},
	};
}

/** Rule module entry. */
export default remoteShellRule;

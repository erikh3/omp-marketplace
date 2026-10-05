import { isObject, type BlockRule } from "./types.ts";

/**
 * Blocks while this agent waits on a difit review session. Only
 * `hub(op="wait", name="difit")` triggers it; every other hub wait and tool call
 * is ignored. Ported from the standalone `difit-herdr-blocked` extension.
 */
export function difitRule(): BlockRule {
	return {
		id: "difit",
		onToolStart(event) {
			if (event.toolName !== "hub") return undefined;
			const args = event.args;
			if (!isObject(args)) return undefined;
			if (args["op"] !== "wait" || args["name"] !== "difit") return undefined;
			return "difit review";
		},
	};
}

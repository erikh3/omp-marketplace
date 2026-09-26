import type { ExtensionAPI, ExtensionContext, ReadonlySessionManager } from "@oh-my-pi/pi-coding-agent";

const MAX_AGENT_NAME_LENGTH = 32;
const FALLBACK_POLL_INTERVAL_MS = 500;
const COMMAND_TIMEOUT_MS = 5_000;
const COMBINING_MARKS = /\p{M}+/gu;
const NON_NAME_CHARACTERS = /[^a-z0-9]+/g;
const EDGE_SEPARATORS = /^-+|-+$/g;

/** Optional live-session callback present in current omp versions. */
interface SessionNameObservable {
	onSessionNameChanged(callback: () => void): () => void;
}

function supportsSessionNameEvents(
	manager: ReadonlySessionManager,
): manager is ReadonlySessionManager & SessionNameObservable {
	return "onSessionNameChanged" in manager && typeof manager.onSessionNameChanged === "function";
}

function normalizedToken(value: string): string {
	return value
		.normalize("NFKD")
		.replace(COMBINING_MARKS, "")
		.toLowerCase()
		.replace(NON_NAME_CHARACTERS, "-")
		.replace(EDGE_SEPARATORS, "");
}

export function sessionTitleToAgentName(title: string, sessionId: string): string {
	const titleToken = normalizedToken(title);
	const sessionToken = normalizedToken(sessionId).slice(0, 8) || "session";
	const candidate = titleToken || `omp-${sessionToken}`;
	const prefixed = /^[a-z]/.test(candidate) ? candidate : `session-${candidate}`;
	return prefixed.slice(0, MAX_AGENT_NAME_LENGTH).replace(/-+$/, "");
}

export function collisionSafeAgentName(name: string, paneId: string): string {
	const paneToken = normalizedToken(paneId).replaceAll("-", "").slice(-6) || "pane";
	const suffix = `-${paneToken}`;
	const stem = name.slice(0, MAX_AGENT_NAME_LENGTH - suffix.length).replace(/-+$/, "") || "omp";
	return `${stem}${suffix}`;
}

function commandFailure(result: { stdout: string; stderr: string; code: number }): string {
	return result.stderr.trim() || result.stdout.trim() || `exit code ${result.code}`;
}

export default function herdrSessionAgentNameSync(pi: ExtensionAPI): void {
	if (process.env.HERDR_ENV !== "1") return;
	const configuredPaneId = process.env.HERDR_PANE_ID?.trim();
	if (!configuredPaneId) {
		pi.logger.warn("herdr-session-agent-name-sync: HERDR_PANE_ID is not set");
		return;
	}
	const paneId = configuredPaneId;

	let stopObserving: (() => void) | undefined;
	let observedSessionState: string | undefined;
	let renameQueue = Promise.resolve();

	async function applyName(name: string | undefined, sessionId: string): Promise<void> {
		try {
			if (!name) {
				const result = await pi.exec("herdr", ["agent", "rename", paneId, "--clear"], {
					timeout: COMMAND_TIMEOUT_MS,
				});
				if (result.code !== 0) {
					pi.logger.warn("herdr-session-agent-name-sync: failed to clear agent name", {
						error: commandFailure(result),
					});
				}
				return;
			}

			const agentName = sessionTitleToAgentName(name, sessionId);
			const result = await pi.exec("herdr", ["agent", "rename", paneId, agentName], {
				timeout: COMMAND_TIMEOUT_MS,
			});
			if (result.code === 0) return;

			const collisionName = collisionSafeAgentName(agentName, paneId);
			const collisionResult = await pi.exec("herdr", ["agent", "rename", paneId, collisionName], {
				timeout: COMMAND_TIMEOUT_MS,
			});
			if (collisionResult.code === 0) return;

			pi.logger.warn("herdr-session-agent-name-sync: failed to rename agent", {
				error: commandFailure(collisionResult),
				initialError: commandFailure(result),
				title: name,
			});
		} catch (error) {
			pi.logger.warn("herdr-session-agent-name-sync: failed to invoke Herdr", {
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	function synchronize(manager: ReadonlySessionManager): Promise<void> {
		const sessionId = manager.getSessionId();
		const name = manager.getSessionName();
		const sessionState = `${sessionId}\0${name ?? ""}`;
		if (sessionState === observedSessionState) return renameQueue;
		observedSessionState = sessionState;
		const rename = () => applyName(name, sessionId);
		renameQueue = renameQueue.then(rename, rename);
		return renameQueue;
	}

	async function observe(ctx: ExtensionContext, clearUnnamed: boolean): Promise<void> {
		stopObserving?.();
		stopObserving = undefined;
		if (ctx.agent.kind !== "main") return;

		const manager = ctx.sessionManager;
		observedSessionState = undefined;
		if (supportsSessionNameEvents(manager)) {
			stopObserving = manager.onSessionNameChanged(() => synchronize(manager));
		} else {
			const timer = ctx.setInterval(() => synchronize(manager), FALLBACK_POLL_INTERVAL_MS);
			stopObserving = () => ctx.clearTimer(timer);
		}
		if (!clearUnnamed && !manager.getSessionName()) {
			observedSessionState = `${manager.getSessionId()}\0`;
			return;
		}
		await synchronize(manager);
	}

	pi.on("session_start", async (_event, ctx) => observe(ctx, false));
	pi.on("session_switch", async (_event, ctx) => observe(ctx, true));
	pi.on("session_shutdown", () => {
		stopObserving?.();
		stopObserving = undefined;
	});
}

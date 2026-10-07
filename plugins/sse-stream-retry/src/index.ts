import type { ExtensionAPI, TurnEndEvent } from "@oh-my-pi/pi-coding-agent";
import { getPluginSettings } from "@oh-my-pi/pi-coding-agent/extensibility/plugins";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";

interface Config {
	enabled: boolean;
}

// Immediate first retry, then exponential-ish backoff, then give up.
const RETRY_DELAYS_MS = [0, 1_000, 3_000, 5_000, 10_000];

// Matches "Error while iterating over SSE stream. -> aborted" and the same family.
const SSE_ABORT_PATTERN = /iterating over sse stream/i;

const DEFAULTS: Config = { enabled: true };

function extractErrorText(errorMessage: unknown): string {
	if (typeof errorMessage === "string") return errorMessage;
	if (errorMessage instanceof Error) return errorMessage.message;
	if (errorMessage !== null && typeof errorMessage === "object" && "message" in errorMessage) {
		return extractErrorText((errorMessage as Record<string, unknown>).message);
	}
	if (errorMessage !== null && typeof errorMessage === "object" && "errorMessage" in errorMessage) {
		return extractErrorText((errorMessage as Record<string, unknown>).errorMessage);
	}
	return "";
}

/**
 * Auto-continues the turn when the model stream aborts with an SSE iteration error.
 * Injects "." after each failure on an escalating delay, resets on any recovered turn,
 * and gives up once the delay sequence is exhausted.
 */
export default function sseStreamRetry(pi: ExtensionAPI): void {
	let config: Config = DEFAULTS;
	let consecutiveFailures = 0;

	pi.on("session_start", async (_event, _ctx) => {
		try {
			const settings = await getPluginSettings("sse-stream-retry", process.cwd());
			config = { enabled: (settings as Record<string, unknown>)["enabled"] !== false };
		} catch {
			config = DEFAULTS;
		}
		consecutiveFailures = 0;
	});

	pi.on("turn_end", (event: TurnEndEvent, ctx) => {
		if (!config.enabled) return;

		const message = event.message as AssistantMessage | undefined;
		if (!message) return;

		// Any recovered (non-error) turn restarts the backoff from the beginning.
		if (message.stopReason !== "error") {
			consecutiveFailures = 0;
			return;
		}

		if (!SSE_ABORT_PATTERN.test(extractErrorText(message.errorMessage))) {
			consecutiveFailures = 0;
			return;
		}

		const attempt = consecutiveFailures;
		const delay = RETRY_DELAYS_MS[attempt];
		if (delay === undefined) {
			ctx.ui.notify(
				`SSE stream aborted ${RETRY_DELAYS_MS.length} times in a row. Giving up; continue manually or restart the turn.`,
				"error",
			);
			return;
		}

		consecutiveFailures++;
		ctx.ui.notify(
			`SSE stream aborted. Auto-continuing in ${(delay / 1000).toFixed(0)}s (${attempt + 1}/${RETRY_DELAYS_MS.length})`,
			"info",
		);
		pi.logger.info(`[sse-stream-retry] SSE stream aborted on attempt ${attempt + 1}, continuing after ${delay}ms`);

		if (delay === 0) {
			pi.sendUserMessage(".");
			return;
		}

		ctx.setTimeout(() => {
			pi.sendUserMessage(".");
		}, delay);
	});
}

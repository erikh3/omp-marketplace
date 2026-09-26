import type { ExtensionAPI, TurnEndEvent } from "@oh-my-pi/pi-coding-agent";
import { getPluginSettings } from "@oh-my-pi/pi-coding-agent/extensibility/plugins";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";

interface Config {
	enabled: boolean;
	proxyHost: string;
	proxyPort: number;
}

interface RetryCause {
	message: string;
	exhaustedMessage: string;
	recovery: string;
	logLabel: string;
}

const RETRY_DELAYS_MS = [0, 3_000, 10_000];

const RETRY_CAUSES: ReadonlyArray<{ pattern: RegExp; cause: RetryCause }> = [
	{
		pattern: /jwt.*expir|expir.*jwt|401.*jwt/i,
		cause: {
			message: "JWT expired",
			exhaustedMessage: "JWT auth failed",
			logLabel: "JWT expired",
			recovery: "Check proxy credentials or restart omp.",
		},
	},
	{
		pattern: /invalid_encrypted_content|encrypted content .*could not be (?:verified|decrypted|parsed)/i,
		cause: {
			message: "encrypted reasoning rejected",
			exhaustedMessage: "encrypted reasoning was rejected",
			logLabel: "encrypted reasoning rejected",
			recovery: "Start a fresh session or switch back to the originating model.",
		},
	},
];

const DEFAULTS: Config = {
	enabled: true,
	proxyHost: "localhost",
	proxyPort: 6655,
};

function loadConfig(settings: Record<string, unknown>): Config {
	return {
		enabled: settings["enabled"] !== false,
		proxyHost:
			typeof settings["proxyHost"] === "string" && settings["proxyHost"].length > 0
				? settings["proxyHost"]
				: DEFAULTS.proxyHost,
		proxyPort:
			typeof settings["proxyPort"] === "number" && settings["proxyPort"] > 0
				? settings["proxyPort"]
				: DEFAULTS.proxyPort,
	};
}

function isHaiEndpoint(baseUrl: string | undefined, config: Config): boolean {
	if (!baseUrl) return false;
	try {
		const url = new URL(baseUrl);
		const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
		return url.hostname === config.proxyHost && port === config.proxyPort;
	} catch {
		return false;
	}
}

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

function retryCause(errorMessage: unknown): RetryCause | undefined {
	const text = extractErrorText(errorMessage);
	return RETRY_CAUSES.find(({ pattern }) => pattern.test(text))?.cause;
}

/** Retries transient HAI Proxy authentication and encrypted-reasoning failures. */
export default function haiJwtRetry(pi: ExtensionAPI): void {
	let config: Config = DEFAULTS;
	let consecutiveFailures = 0;

	pi.on("session_start", async (_event, _ctx) => {
		try {
			const settings = await getPluginSettings("hai-jwt-retry", process.cwd());
			config = loadConfig(settings as Record<string, unknown>);
		} catch {
			config = DEFAULTS;
		}
		consecutiveFailures = 0;
	});

	pi.on("turn_end", (event: TurnEndEvent, ctx) => {
		if (!config.enabled) return;

		const message = event.message as AssistantMessage | undefined;
		if (!message) return;

		if (message.stopReason !== "error") {
			consecutiveFailures = 0;
			return;
		}

		const model = ctx.models.current();
		if (!isHaiEndpoint(model?.baseUrl, config)) return;

		const cause = retryCause(message.errorMessage);
		if (!cause) {
			consecutiveFailures = 0;
			return;
		}

		const attempt = consecutiveFailures;
		const delay = RETRY_DELAYS_MS[attempt];
		if (delay === undefined) {
			ctx.ui.notify(
				`HAI proxy: ${cause.exhaustedMessage} ${RETRY_DELAYS_MS.length} times in a row. ${cause.recovery}`,
				"error",
			);
			return;
		}

		consecutiveFailures++;
		ctx.ui.notify(
			`HAI proxy: ${cause.message}. Auto-retrying in ${(delay / 1000).toFixed(0)}s (${attempt + 1}/${RETRY_DELAYS_MS.length})`,
			"info",
		);

		pi.logger.info(`[hai-jwt-retry] ${cause.logLabel} on attempt ${attempt + 1}, retrying after ${delay}ms`);

		if (delay === 0) {
			pi.sendUserMessage(".");
			return;
		}

		ctx.setTimeout(() => {
			pi.sendUserMessage(".");
		}, delay);
	});
}

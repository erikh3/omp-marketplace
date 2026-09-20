import type { ExtensionAPI, TurnEndEvent } from "@oh-my-pi/pi-coding-agent";
import { getPluginSettings } from "@oh-my-pi/pi-coding-agent/extensibility/plugins";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";

interface Config {
	enabled: boolean;
	proxyHost: string;
	proxyPort: number;
}

const RETRY_DELAYS_MS = [0, 3_000, 10_000];

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

function isJwtExpiredError(errorMessage: unknown): boolean {
	const text = extractErrorText(errorMessage);
	// Matches: "401 Jwt is expired", "jwt expired", "JWT has expired", etc.
	return /jwt.*expir|expir.*jwt|401.*jwt/i.test(text);
}

/** Auto-retries the current agent turn when HAI proxy returns a JWT-expired 401. */
export default function haiJwtRetry(pi: ExtensionAPI): void {
	let config: Config = DEFAULTS;
	let consecutiveJwtFailures = 0;

	pi.on("session_start", async (_event, _ctx) => {
		try {
			const settings = await getPluginSettings("hai-jwt-retry", process.cwd());
			config = loadConfig(settings as Record<string, unknown>);
		} catch {
			config = DEFAULTS;
		}
		consecutiveJwtFailures = 0;
	});

	pi.on("turn_end", (event: TurnEndEvent, ctx) => {
		if (!config.enabled) return;

		const message = event.message as AssistantMessage | undefined;
		if (!message) return;

		if (message.stopReason !== "error") {
			// Successful turn resets the consecutive-failure counter.
			consecutiveJwtFailures = 0;
			return;
		}

		const model = ctx.models.current();
		if (!isHaiEndpoint(model?.baseUrl, config)) return;

		if (!isJwtExpiredError(message.errorMessage)) return;

		const attempt = consecutiveJwtFailures;
		const delay = RETRY_DELAYS_MS[attempt];
		if (delay === undefined) {
			ctx.ui.notify(
				`HAI proxy: JWT auth failed ${RETRY_DELAYS_MS.length} times in a row. Check proxy credentials or restart omp.`,
				"error",
			);
			return;
		}

		consecutiveJwtFailures++;
		ctx.ui.notify(
			`HAI proxy: JWT expired. Auto-retrying in ${(delay / 1000).toFixed(0)}s (${attempt + 1}/${RETRY_DELAYS_MS.length})`,
			"info",
		);

		pi.logger.info(`[hai-jwt-retry] JWT expired on attempt ${attempt + 1}, retrying after ${delay}ms`);

		if (delay === 0) {
			pi.sendUserMessage(".");
			return;
		}

		ctx.setTimeout(() => {
			pi.sendUserMessage(".");
		}, delay);
	});
}

import type { ExtensionAPI, TurnEndEvent } from "@oh-my-pi/pi-coding-agent";
import { getPluginSettings } from "@oh-my-pi/pi-coding-agent/extensibility/plugins";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";

interface Config {
	enabled: boolean;
	proxyHost: string;
	proxyPort: number;
	maxRetries: number;
	baseDelayMs: number;
}

const DEFAULTS: Config = {
	enabled: true,
	proxyHost: "localhost",
	proxyPort: 6655,
	maxRetries: 2,
	baseDelayMs: 2000,
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
		maxRetries:
			typeof settings["maxRetries"] === "number" && settings["maxRetries"] >= 0
				? Math.floor(settings["maxRetries"])
				: DEFAULTS.maxRetries,
		baseDelayMs:
			typeof settings["baseDelayMs"] === "number" && settings["baseDelayMs"] >= 0
				? settings["baseDelayMs"]
				: DEFAULTS.baseDelayMs,
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

		if (consecutiveJwtFailures >= config.maxRetries) {
			ctx.ui.notify(
				`HAI proxy: JWT auth failed ${config.maxRetries} times in a row. Check proxy credentials or restart omp.`,
				"error",
			);
			return;
		}

		consecutiveJwtFailures++;
		const attempt = consecutiveJwtFailures;
		// Increase delay with each attempt so the background refresher has time.
		const delay = config.baseDelayMs * attempt;

		ctx.ui.notify(
			`HAI proxy: JWT expired — auto-retrying in ${(delay / 1000).toFixed(0)}s (${attempt}/${config.maxRetries})`,
			"info",
		);

		pi.logger.info(`[hai-jwt-retry] JWT expired on attempt ${attempt}, retrying after ${delay}ms`);

		ctx.setTimeout(() => {
			pi.sendUserMessage("(auto-retry: HAI proxy JWT refreshed)");
		}, delay);
	});
}

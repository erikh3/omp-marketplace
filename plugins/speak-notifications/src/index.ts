import type { ExtensionAPI, ExtensionContext, Settings } from "@oh-my-pi/pi-coding-agent";

import { NotificationController, validateNotificationText } from "./controller.ts";
import { GUIDANCE } from "./guidance.ts";
import { startLocalPlayback } from "./playback.ts";
import type { LocalPlaybackOptions } from "./playback.ts";

const MILESTONE_INTERVAL_MS = 300_000;
const MAX_RECENT_TEXTS = 32;

export default function speakNotifications(pi: ExtensionAPI) {
	let registered = false;
	let context: ExtensionContext;
	let sessionSettings: Settings;
	let lastAcceptedAt: number | undefined;
	const recentTexts = new Set<string>();
	const parameters = pi.zod.object({
		text: pi.zod.string(),
		purpose: pi.zod.enum(["outcome", "attention", "milestone"])
	});
	// Compiled OMP resolves these host subpaths through its extension loader.
	const hostApis = Promise.all([
		import("@oh-my-pi/pi-coding-agent/config/model-resolver"),
		import("@oh-my-pi/pi-coding-agent/config/model-roles"),
		import("@oh-my-pi/pi-coding-agent/config/registry"),
		import("@oh-my-pi/pi-coding-agent/config/settings"),
		import("@oh-my-pi/pi-catalog/compat/behavior")
	]);
	let apis: Awaited<typeof hostApis>;

	function resolvePlaybackOptions(): LocalPlaybackOptions {
		const [resolver, roles, registry, , catalog] = apis;
		const voice = registry.lookup("tts.localVoice")?.get(sessionSettings);
		const speed = registry.lookup("tts.localSpeed")?.get(sessionSettings);
		if (typeof voice !== "string" || typeof speed !== "number") throw new Error("OMP does not expose the required local TTS voice and speed settings.");
		const candidates = resolver.resolveRoleChain("speech", sessionSettings, roles.roleCandidatePool("speech", sessionSettings, context.modelRegistry));
		const local = candidates.find(candidate => candidate.model.api === "local-inference")?.model;
		const fallback = local ? undefined : catalog.roleDefaultModels().speech.map(selector => context.models.resolve(selector)).find(model => model?.api === "local-inference");
		const model = local?.id ?? fallback?.id;
		if (!model) throw new Error("OMP does not expose a default local speech model.");
		return { model, voice, speed, cwd: context.cwd };
	}

	function resetFrequency() {
		lastAcceptedAt = undefined;
		recentTexts.clear();
	}

	function notice(enabled: boolean, display = true) {
		pi.sendMessage({ customType: "speak-notifications-state", content: `Speech notifications ${enabled ? "enabled" : "disabled"} for this session.`, details: { enabled }, display, attribution: "agent" }, { triggerTurn: false });
	}

	const controller = new NotificationController(
		text => startLocalPlayback(text, resolvePlaybackOptions()),
		message => {
			context.ui.notify(`Speak notifications: ${message}`, "error");
			pi.sendMessage({ customType: "speak-notifications-error", content: `Speech notification failed: ${message}`, display: true, attribution: "agent" }, { triggerTurn: false });
		}
	);

	async function initialize(ctx: ExtensionContext) {
		if (ctx.agent.kind !== "main") return;
		resetFrequency();
		await controller.disable();
		await controller.reset();
		context = ctx;
		apis = await hostApis;
		const scoped = apis[3].findScopedSettings();
		if (!scoped) throw new Error("OMP does not expose this session's live settings.");
		sessionSettings = scoped;
		if (registered) return notice(false, false);
		pi.registerTool({
			name: "speak_notification",
			label: "Speech notification",
			description: GUIDANCE,
			loadMode: "essential",
			parameters,
			async execute(_id, params) {
				if (!controller.status().enabled) {
					const result = controller.enqueue("");
					return { content: [{ type: "text", text: result.message }], details: result };
				}
				const validation = validateNotificationText(params.text);
				if (!validation.accepted) return { content: [{ type: "text", text: validation.message }], details: validation, isError: true };
				const key = validation.message.replace(/\s+/gu, " ");
				const now = performance.now();
				const suppression = recentTexts.has(key)
					? "This text was already queued in this task. Do not repeat or rephrase it."
					: params.purpose === "milestone" && lastAcceptedAt !== undefined && now - lastAcceptedAt < MILESTONE_INTERVAL_MS
						? "Progress speech is limited to once per five minutes. Continue the task; do not retry this update."
						: undefined;
				if (suppression) return { content: [{ type: "text", text: suppression }], details: { accepted: false, suppressed: true, message: suppression } };
				const result = controller.enqueue(validation.message);
				if (result.accepted) {
					lastAcceptedAt = now;
					recentTexts.add(key);
					if (recentTexts.size > MAX_RECENT_TEXTS) recentTexts.delete(recentTexts.values().next().value!);
				}
				return { content: [{ type: "text", text: result.message }], details: result, isError: !result.accepted };
			}
		});
		registered = true;
		await pi.setActiveTools([...new Set([...pi.getActiveTools(), "speak_notification"])]);
		notice(false, false);
	}

	pi.on("session_start", async (_event, ctx) => initialize(ctx));
	pi.on("session_switch", async (_event, ctx) => initialize(ctx));
	pi.on("session_shutdown", async (_event, ctx) => {
		if (ctx.agent.kind !== "main") return;
		resetFrequency();
		await controller.shutdown();
	});
	pi.on("before_agent_start", (event, ctx) => {
		if (ctx.agent.kind === "main" && event.reason === "prompt") recentTexts.clear();
	});
	pi.on("context", (event, ctx) => {
		if (ctx.agent.kind !== "main") return;
		const content = controller.status().enabled
			? "Speech notifications are enabled. Use speak_notification only at the trigger points in its description; all spoken text must be your own."
			: "Speech notifications are disabled. Do not call speak_notification.";
		return { messages: [{ role: "developer", content: [{ type: "text", text: content }], attribution: "agent", timestamp: Date.now() }, ...event.messages] };
	});
	pi.registerMessageRenderer<{ enabled: boolean }>("speak-notifications-state", (message, _options, theme) => new pi.pi.Text(theme.fg("muted", `Speech notifications ${message.details?.enabled ? "on" : "off"}.`), 0, 0));
	pi.registerCommand("speak", {
		description: "Toggle speech notifications, showing status when enabled, or use on | off | status",
		getArgumentCompletions(prefix) {
			if (!prefix || prefix.includes(" ")) return null;
			const matches = ["on", "off", "status"].filter(value => value.startsWith(prefix)).map(value => ({ value, label: value }));
			return matches.length ? matches : null;
		},
		async handler(args, ctx) {
			if (ctx.agent.kind !== "main") return;
			const command = args === "" ? (controller.status().enabled ? "off" : "on") : args;
			if (command === "on") {
				controller.enable();
				notice(true);
			} else if (command === "off") {
				resetFrequency();
				await controller.disable();
				notice(false);
			} else if (command !== "status") {
				ctx.ui.notify("Usage: /speak [on | off | status]", "warning");
				return;
			}
			if ((args === "" && command === "on") || command === "status") {
				const state = controller.status();
				let configuration: string;
				try { const options = resolvePlaybackOptions(); configuration = `Model: ${options.model}\nVoice: ${options.voice}\nSpeed: ${options.speed}`; }
				catch (error) { configuration = `Configuration error: ${String(error)}`; }
				pi.sendMessage({ customType: "speak-notifications-status", attribution: "agent", display: true, content: `Speech notifications: ${state.enabled ? "on" : "off"}\nPlayback: ${state.activePlayback ? "active" : "idle"}\nWaiting: ${state.queueDepth}/${state.queueLimit}\n\n${configuration}${state.lastPlaybackError ? `\n\nPlayback error: ${state.lastPlaybackError}` : ""}` }, { triggerTurn: false });
			}
		}
	});
}

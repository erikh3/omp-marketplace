import type { ExtensionAPI, ExtensionContext, Settings } from "@oh-my-pi/pi-coding-agent";

import { NotificationController } from "./controller.ts";
import { startLocalPlayback } from "./playback.ts";
import type { LocalPlaybackOptions } from "./playback.ts";

const GUIDANCE = `## Deliberate speech notifications

Use \`speak_notification\` for deliberate text-to-speech notifications only. It is the only permitted speech path. Do not invoke \`omp say\` or any other speech command through Bash. Subagents must not invoke this tool.

Refer to the latest speak-notifications system notice for the session's enabled state. The tool also reports whether notifications are enabled. If it reports disabled, do not retry unless the user subsequently enables notifications.

When enabled, you MUST call \`speak_notification\` when you encounter a blocker or need the user's decision, and when a long-running operation completes or fails. Choose a short outcome or required-action message yourself; do not wait for the user to request speech. Before ending a substantial task, announce its outcome once. Brief updates at meaningful phase boundaries are allowed. Do not speak every response, greetings, routine tool progress, repeated status, markdown, paths, URLs, code, tables, or logs.

Use one or two plain sentences, normally under 25 words. Lead with the outcome or required action. Combine related outcomes into one notification. Do not repeat an event already announced. Queue at most one notification per task phase unless the user requests a walkthrough.`;

export default function speakNotifications(pi: ExtensionAPI) {
	let registered = false;
	let context: ExtensionContext;
	let sessionSettings: Settings;

	const parameters = pi.zod.object({ text: pi.zod.string() });
	// Compiled OMP resolves these host subpaths at runtime, not during static graph loading.
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
		if (typeof voice !== "string" || typeof speed !== "number") {
			throw new Error("OMP does not expose the required local TTS voice and speed settings.");
		}
		const candidates = resolver.resolveRoleChain("speech", sessionSettings,
			roles.roleCandidatePool("speech", sessionSettings, context.modelRegistry));
		const local = candidates.find(candidate => candidate.model.api === "local-inference")?.model;
		const fallback = local ? undefined : catalog.roleDefaultModels().speech
			.map(selector => context.models.resolve(selector))
			.find(model => model?.api === "local-inference");
		const model = local?.id ?? fallback?.id;
		if (!model) throw new Error("OMP does not expose a default local speech model.");
		return { model, voice, speed, cwd: context.cwd };
	}

	function notice(enabled: boolean, display = true) {
		pi.sendMessage({
			customType: "speak-notifications-state",
			content: enabled
				? "Speech notifications are enabled for this session. You MUST notify the user of blockers and decision requests, completion or failure of long-running operations, and the final outcome of a substantial task. Choose the message yourself using speak_notification; do not wait for a speech request. Keep routine tool progress in text."
				: "Speech notifications are disabled for this session. Do not call speak_notification unless the user subsequently enables notifications.",
			details: { enabled },
			display,
			attribution: "agent"
		}, { triggerTurn: false });
	}

	const controller = new NotificationController(
		text => startLocalPlayback(text, resolvePlaybackOptions()),
		message => {
			context.ui.notify(`Speak notifications: ${message}`, "error");
			pi.sendMessage({ customType: "speak-notifications-error", content: `Speech notification failed: ${message}`,
				display: true, attribution: "agent" }, { triggerTurn: false });
		}
	);

	async function initialize(ctx: ExtensionContext) {
		if (ctx.agent.kind !== "main") return;
		await controller.reset();
		context = ctx;
		apis = await hostApis;
		const scoped = apis[3].findScopedSettings();
		if (!scoped) throw new Error("OMP does not expose this session's live settings.");
		sessionSettings = scoped;
		if (!registered) {
			pi.registerTool({
				name: "speak_notification",
				label: "Speech notification",
				description: "Queue deliberate local speech for the primary agent. When enabled, MUST announce blockers, decision requests, long-running operation completion/failure, and substantial task outcomes. Choose short wording yourself; no routine tool progress.",
				loadMode: "essential",
				parameters,
				async execute(_id, params) {
					const result = controller.enqueue(params.text);
					return { content: [{ type: "text", text: result.message }], details: result, isError: !result.accepted && controller.status().enabled };
				}
			});
			registered = true;
			await pi.setActiveTools([...new Set([...pi.getActiveTools(), "speak_notification"])]);
		}
		notice(false, false);
	}

	pi.on("session_start", async (_event, ctx) => initialize(ctx));
	pi.on("session_switch", async (_event, ctx) => initialize(ctx));
	pi.on("session_shutdown", async (_event, ctx) => {
		if (ctx.agent.kind === "main") await controller.shutdown();
	});
	pi.registerMessageRenderer<{ enabled: boolean }>("speak-notifications-state", (message, _options, theme) =>
		new pi.pi.Text(theme.fg("muted", `Speech notifications ${message.details?.enabled ? "on" : "off"}.`), 0, 0));
	pi.on("before_agent_start", (_event, ctx) => {
		if (ctx.agent.kind !== "main") return;
		return { systemPrompt: [..._event.systemPrompt, GUIDANCE] };
	});
	pi.registerCommand("speak", {
		description: "Enable, disable, or inspect deliberate speech notifications: on | off | status",
		async handler(args, ctx) {
			if (ctx.agent.kind !== "main") return;
			if (args === "on") {
				controller.enable();
				notice(true);
			} else if (args === "off") {
				await controller.disable();
				notice(false);
			} else if (args === "status") {
				const state = controller.status();
				let configuration: string;
				try {
					const options = resolvePlaybackOptions();
					configuration = `Model: ${options.model}\nVoice: ${options.voice}\nSpeed: ${options.speed}`;
				} catch (error) {
					configuration = `Configuration error: ${String(error)}`;
				}
				pi.sendMessage({ customType: "speak-notifications-status", attribution: "agent", display: true,
					content: `Speech notifications: ${state.enabled ? "on" : "off"}\nPlayback: ${state.activePlayback ? "active" : "idle"}\nWaiting: ${state.queueDepth}/${state.queueLimit}\n\n${configuration}${state.lastPlaybackError ? `\n\nPlayback error: ${state.lastPlaybackError}` : ""}`
				}, { triggerTurn: false });
			} else {
				ctx.ui.notify("Usage: /speak on | off | status", "warning");
			}
		}
	});
}

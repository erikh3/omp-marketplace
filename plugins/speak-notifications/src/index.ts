import type { ExtensionAPI, ExtensionContext, Settings } from "@oh-my-pi/pi-coding-agent";

import { NotificationController } from "./controller.ts";
import { COMPLETION_CHECK, GUIDANCE, silenceReminder } from "./guidance.ts";
import { startLocalPlayback } from "./playback.ts";
import type { LocalPlaybackOptions } from "./playback.ts";
import { ReminderClock } from "./reminder-clock.ts";

export default function speakNotifications(pi: ExtensionAPI) {
	let registered = false;
	let context: ExtensionContext;
	let sessionSettings: Settings;
	let workCalls = 0;
	let changedFiles = false;
	let completionChecked = false;
	let taskStarted = 0;
	// Expiry stays pending until the next model request, including after a tool wait.
	const reminderClock = new ReminderClock();

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
				? "Speech notifications are enabled for this session. Announce substantial task outcomes and user-action blockers using speak_notification. Choose significance and wording yourself. Keep routine progress in text."
				: "Speech notifications are disabled for this session. Do not call speak_notification unless the user subsequently enables notifications.",
			details: { enabled },
			display,
			attribution: "agent"
		}, { triggerTurn: false });
	}

	const controller = new NotificationController(
		text => {
			reminderClock.playbackStarted();
			return startLocalPlayback(text, resolvePlaybackOptions());
		},
		message => {
			context.ui.notify(`Speak notifications: ${message}`, "error");
			pi.sendMessage({ customType: "speak-notifications-error", content: `Speech notification failed: ${message}`,
				display: true, attribution: "agent" }, { triggerTurn: false });
		},
		success => reminderClock.playbackFinished(success)
	);

	async function initialize(ctx: ExtensionContext) {
		if (ctx.agent.kind !== "main") return;
		reminderClock.disable();
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
				description: "Queue short local speech for the primary agent. When enabled, announce each substantial task outcome and user-action blocker. Judge significance yourself; no routine tool chatter. Timer reminders permit silence when nothing merits speech.",
				loadMode: "essential",
				parameters,
				async execute(_id, params) {
					const result = controller.enqueue(params.text);
					if (result.accepted) {
						reminderClock.playbackStarted();
					}
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
		if (ctx.agent.kind !== "main") return;
		reminderClock.dispose();
		await controller.shutdown();
	});
	pi.registerMessageRenderer<{ enabled: boolean }>("speak-notifications-state", (message, _options, theme) =>
		new pi.pi.Text(theme.fg("muted", `Speech notifications ${message.details?.enabled ? "on" : "off"}.`), 0, 0));
	pi.on("before_agent_start", (_event, ctx) => {
		if (ctx.agent.kind !== "main") return;
		workCalls = 0;
		changedFiles = false;
		completionChecked = false;
		taskStarted = Date.now();
		return { systemPrompt: [..._event.systemPrompt, GUIDANCE] };
	});
	pi.on("context", (event, ctx) => {
		if (ctx.agent.kind !== "main") return;
		const enabled = controller.status().enabled;
		const elapsed = reminderClock.takeReminder();
		const completionCheck = enabled && !completionChecked && workCalls > 0 &&
			(changedFiles || workCalls >= 3 || Date.now() - taskStarted >= 60_000);
		if (completionCheck) completionChecked = true;
		const content = `Current speech notifications state: ${enabled ? "enabled" : "disabled"}. This live state overrides all older state notices. ${enabled ? "Judge notification significance yourself; announce substantial outcomes and user-action blockers." : "Do not call speak_notification."}${elapsed === undefined ? "" : ` ${silenceReminder(elapsed)}`}${completionCheck ? ` ${COMPLETION_CHECK}` : ""}`;
		return { messages: [...event.messages, { role: "custom", customType: "speak-notifications-current",
			content, display: false, attribution: "agent", timestamp: Date.now() }] };
	});
	pi.on("tool_result", (event, ctx) => {
		if (ctx.agent.kind !== "main") return;
		let toolName = event.toolName;
		const details: unknown = event.details;
		if (details && typeof details === "object" && "xdev" in details) {
			const xdev = details.xdev;
			if (xdev && typeof xdev === "object" && "tool" in xdev && typeof xdev.tool === "string") toolName = xdev.tool;
		}
		if (toolName === "speak_notification") return;
		workCalls++;
		if (!event.isError && (toolName === "edit" || toolName === "write")) changedFiles = true;
	});
	pi.registerCommand("speak", {
		description: "Toggle speech notifications, showing status when enabled, or use on | off | status",
		getArgumentCompletions(prefix) {
			if (!prefix || prefix.includes(" ")) return null;
			const matches = ["on", "off", "status"]
				.filter(value => value.startsWith(prefix))
				.map(value => ({ value, label: value }));
			return matches.length ? matches : null;
		},
		async handler(args, ctx) {
			if (ctx.agent.kind !== "main") return;
			const command = args === "" ? (controller.status().enabled ? "off" : "on") : args;
			if (command === "on") {
				controller.enable();
				reminderClock.enable();
				notice(true);
			} else if (command === "off") {
				reminderClock.disable();
				await controller.disable();
				notice(false);
			} else if (command !== "status") {
				ctx.ui.notify("Usage: /speak [on | off | status]", "warning");
				return;
			}
			if ((args === "" && command === "on") || command === "status") {
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
			}
		}
	});
}

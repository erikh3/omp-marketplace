import { resolve } from "node:path";
import type { AgentToolResult, ExtensionAPI, ExtensionContext, Settings } from "@oh-my-pi/pi-coding-agent";

import { Checkpoints, canonicalPlanTarget, canonicalToolTarget } from "./checkpoints.ts";
import { NotificationController, validateNotificationText } from "./controller.ts";
import type { EnqueueResult } from "./controller.ts";
import { ATTENTION_RECOVERY, GUIDANCE, OUTCOME_RECOVERY, silenceReminder } from "./guidance.ts";
import { startLocalPlayback } from "./playback.ts";
import type { LocalPlaybackOptions } from "./playback.ts";
import { ReminderClock } from "./reminder-clock.ts";


function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function terminalTextOutcome(messages: unknown[]): boolean {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = asRecord(messages[index]);
		if (message?.role !== "assistant") continue;
		if (message.stopReason !== "stop" || !Array.isArray(message.content) || message.content.length === 0) return false;
		return message.content.every(content => {
			const block = asRecord(content);
			return block?.type === "text" && typeof block.text === "string" && block.text.length > 0;
		});
	}
	return false;
}

export default function speakNotifications(pi: ExtensionAPI) {
	let registered = false;
	let context: ExtensionContext;
	let sessionSettings: Settings;
	let workCalls = 0;
	let changedFiles = false;
	let taskStarted = 0;
	let loopActive = false;
	let backgroundResultPending = false;
	const userWaits = new Set<string>();
	const checkpoints = new Checkpoints();
	const reminderClock = new ReminderClock();
	const dispatches = new Map<string, { target: string; checkpointId?: string; blockedCheckpointId?: string }>();
	const recoveryTurns = new Map<string, { deadline: number; originCallId?: string }>();
	let currentTurn = 0;
	let timerInstructionDelivered = false;
	let pendingUserPrompt = false;

	const toolBoundary = pi.zod.object({
		kind: pi.zod.literal("tool"),
		toolName: pi.zod.string(),
		input: pi.zod.record(pi.zod.unknown())
	});
	const planBoundary = pi.zod.object({
		kind: pi.zod.literal("plan-review"),
		planFilePath: pi.zod.string()
	});
	const parameters = pi.zod.object({
		action: pi.zod.enum(["speak", "silent"]),
		purpose: pi.zod.enum(["outcome", "attention", "milestone"]),
		checkpointId: pi.zod.string().optional(),
		boundary: pi.zod.union([toolBoundary, planBoundary]).optional(),
		text: pi.zod.string().optional(),
		reason: pi.zod.string().optional()
	});
	// OMP publishes these runtime-selected subpaths; static imports would fail in its extension loader.
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

	function updateActivity(ctx: ExtensionContext) {
		const jobs = ctx.getAsyncJobSnapshot();
		reminderClock.setWorking(loopActive || (jobs?.running.length ?? 0) > 0);
		reminderClock.setWaiting(userWaits.size > 0);
	}

	function unresolved(checkpointId: string, cause: string) {
		const checkpoint = checkpoints.find(checkpointId, "attention") ?? checkpoints.find(checkpointId, "outcome");
		if (!checkpoint || !checkpoints.markUnresolved(checkpoint, cause)) return;
		pi.sendMessage({ customType: "speak-notifications-unresolved", content: "Speech notification decision was not recorded. The task or prompt remains available.", display: true, attribution: "agent" }, { triggerTurn: false });
	}

	function notice(enabled: boolean, display = true) {
		pi.sendMessage({ customType: "speak-notifications-state", content: enabled
			? "Session metadata: speech notifications enabled. This is not a task or a request for acknowledgement."
			: "Session metadata: speech notifications disabled. This is not a task or a request for acknowledgement.", details: { enabled }, display, attribution: "agent" }, { triggerTurn: false });
	}

	const controller = new NotificationController(
		text => {
			reminderClock.playbackStarted();
			return startLocalPlayback(text, resolvePlaybackOptions());
		},
		message => {
			context.ui.notify(`Speak notifications: ${message}`, "error");
			pi.sendMessage({ customType: "speak-notifications-error", content: `Speech notification failed: ${message}`, display: true, attribution: "agent" }, { triggerTurn: false });
		},
		success => {
			reminderClock.playbackFinished(success);
			if (controller.status().queueDepth > 0) reminderClock.playbackStarted();
		}
	);

	async function initialize(ctx: ExtensionContext) {
		if (ctx.agent.kind !== "main") return;
		reminderClock.disable();
		checkpoints.disable();
		loopActive = false;
		backgroundResultPending = false;
		userWaits.clear();
		reminderClock.setWorking(false);
		reminderClock.setWaiting(false);
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
			async execute(_id, params): Promise<AgentToolResult<EnqueueResult | { action: "silent"; purpose: string }>> {
				if (!controller.status().enabled) {
					const result = controller.enqueue("");
					return { content: [{ type: "text", text: result.message }], details: result };
				}
				const boundary = params.boundary;
				if (params.checkpointId && boundary) return { content: [{ type: "text", text: "Use either checkpointId or boundary, not both." }], isError: true };
				if (params.purpose === "milestone" && (params.checkpointId || boundary)) return { content: [{ type: "text", text: "Milestones cannot bind a checkpoint or boundary." }], isError: true };
				let checkpoint;
				if (params.checkpointId) {
					const purpose = params.purpose === "milestone" ? "outcome" : params.purpose;
					checkpoint = checkpoints.find(params.checkpointId, purpose);
					if (!checkpoint && purpose === "attention" && checkpoints.find(params.checkpointId, "outcome")) {
						return { content: [{ type: "text", text: "This is an outcome checkpoint. For attention, supply the exact boundary or wait for an attention checkpoint." }], isError: true };
					}
					if (!checkpoint && checkpoints.isResolved(params.checkpointId, purpose)) {
						return { content: [{ type: "text", text: "Decision already recorded." }], details: { accepted: true, message: "Decision already recorded." } };
					}
					if (!checkpoint) return { content: [{ type: "text", text: "This checkpoint is stale or does not match the purpose." }], isError: true };
				}
				else if (params.purpose === "attention" && boundary?.kind === "tool") {
					if (!pi.getActiveTools().includes(boundary.toolName)) return { content: [{ type: "text", text: "The boundary tool is not active in this session." }], isError: true };
					if (params.action === "silent" && !params.reason?.trim()) return { content: [{ type: "text", text: "A silent decision requires a short reason." }], isError: true };
					if (params.action === "speak") {
						const validation = validateNotificationText(params.text ?? "");
						if (!validation.accepted) return { content: [{ type: "text", text: validation.message }], details: validation, isError: true };
						if (controller.status().queueDepth >= controller.status().queueLimit) {
							const result = controller.enqueue(params.text ?? "");
							return { content: [{ type: "text", text: result.message }], details: result, isError: true };
						}
					}
					checkpoint = checkpoints.attention(canonicalToolTarget(boundary.toolName, boundary.input));
				} else if (params.purpose === "attention" && boundary?.kind === "plan-review") {
					const epoch = checkpoints.epoch();
					const path = resolve(context.cwd, boundary.planFilePath);
					const content = await Bun.file(path).text().catch(() => undefined);
					if (content === undefined || !controller.status().enabled || checkpoints.epoch() !== epoch) return { content: [{ type: "text", text: "The plan boundary is no longer available." }], isError: true };
					if (params.action === "silent" && !params.reason?.trim()) return { content: [{ type: "text", text: "A silent decision requires a short reason." }], isError: true };
					if (params.action === "speak") {
						const validation = validateNotificationText(params.text ?? "");
						if (!validation.accepted) return { content: [{ type: "text", text: validation.message }], details: validation, isError: true };
						if (controller.status().queueDepth >= controller.status().queueLimit) {
							const result = controller.enqueue(params.text ?? "");
							return { content: [{ type: "text", text: result.message }], details: result, isError: true };
						}
					}
					checkpoint = checkpoints.attention(canonicalPlanTarget(path, content));
				} else if (params.purpose !== "milestone") return { content: [{ type: "text", text: "Outcome and existing attention decisions require checkpointId." }], isError: true };
				if (params.purpose === "attention" && !checkpoint) return { content: [{ type: "text", text: "The notification checkpoint limit is reached." }], isError: true };
				if (params.action === "silent") {
					if (!params.reason?.trim()) return { content: [{ type: "text", text: "A silent decision requires a short reason." }], isError: true };
					if (!checkpoint) return { content: [{ type: "text", text: "Silent milestone recorded." }], details: { action: "silent", purpose: params.purpose } };
					if (checkpoint.decision === "unresolved") return { content: [{ type: "text", text: "This checkpoint is unresolved." }], isError: true };
					const decision = checkpoints.resolve(checkpoint, "silent");
					if (decision === "accepted") recoveryTurns.delete(checkpoint.id);
					return { content: [{ type: "text", text: decision === "accepted" ? "Silent decision recorded." : "Decision already recorded." }], details: { action: "silent", purpose: params.purpose } };
				}
				if (checkpoint && checkpoint.decision !== "pending") {
					return { content: [{ type: "text", text: checkpoint.decision === "unresolved" ? "This checkpoint is unresolved." : "Decision already recorded." }], details: { accepted: checkpoint.decision !== "unresolved", message: "Decision already recorded." }, isError: checkpoint.decision === "unresolved" };
				}
				const text = params.text ?? "";
				const textValidation = validateNotificationText(text);
				if (!textValidation.accepted) return { content: [{ type: "text", text: textValidation.message }], details: textValidation, isError: true };
				const result = controller.enqueue(text);
				if (!result.accepted) return { content: [{ type: "text", text: result.message }], details: result, isError: true };
				if (checkpoint && checkpoints.resolve(checkpoint, "speak") === "accepted") recoveryTurns.delete(checkpoint.id);
				reminderClock.playbackStarted();
				return { content: [{ type: "text", text: result.message }], details: result };
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
		reminderClock.dispose();
		checkpoints.disable();
		dispatches.clear();
		recoveryTurns.clear();
		backgroundResultPending = false;
		userWaits.clear();
		await controller.shutdown();
	});
	pi.registerMessageRenderer<{ enabled: boolean }>("speak-notifications-state", (message, _options, theme) => new pi.pi.Text(theme.fg("muted", `Speech notifications ${message.details?.enabled ? "on" : "off"}.`), 0, 0));
	pi.on("before_agent_start", (event, ctx) => {
		if (ctx.agent.kind !== "main") return;
		if (event.reason === "prompt") pendingUserPrompt = true;
	});
	pi.on("turn_start", (_event, ctx) => {
		if (ctx.agent.kind !== "main") return;
		currentTurn++;
		updateActivity(ctx);
		timerInstructionDelivered = false;
	});
	pi.on("agent_start", (_event, ctx) => {
		if (ctx.agent.kind !== "main") return;
		if (pendingUserPrompt) {
			pendingUserPrompt = false;
			workCalls = 0;
			changedFiles = false;
			backgroundResultPending = false;
			taskStarted = performance.now();
			dispatches.clear();
			recoveryTurns.clear();
			if (controller.status().enabled) checkpoints.startTask();
		}
		loopActive = true;
		updateActivity(ctx);
	});
	pi.on("agent_end", (event, ctx) => {
		if (ctx.agent.kind !== "main") return;
		loopActive = false;
		for (let index = event.messages.length - 1; index >= 0; index--) {
			const message = event.messages[index];
			if (message?.role === "assistant" && message.stopReason === "aborted" && !event.willContinue) {
				checkpoints.disable();
				dispatches.clear();
				recoveryTurns.clear();
				backgroundResultPending = false;
			}
			if (message?.role === "assistant") break;
		}
		updateActivity(ctx);
		if (controller.status().enabled && !event.willContinue && !event.awaitingAsyncWork && terminalTextOutcome(event.messages)) {
			const candidate = backgroundResultPending || (workCalls > 0 && (changedFiles || workCalls >= 3 || performance.now() - taskStarted >= 60_000));
			const outcome = candidate ? checkpoints.outcome() : undefined;
			if (outcome?.decision === "pending") {
				if (checkpoints.markRecovery(outcome)) {
					pi.sendMessage({ customType: "speak-notifications-outcome-recovery", content: `${OUTCOME_RECOVERY} Checkpoint ID: ${outcome.id}`, display: false, attribution: "agent" }, { triggerTurn: true, deliverAs: "nextTurn" });
				} else unresolved(outcome.id, "decision omitted after recovery");
			}
		}
	});
	pi.on("message_end", (event, ctx) => {
		if (ctx.agent.kind !== "main" || !controller.status().enabled) return;
		if (event.message.role === "custom" && event.message.customType === "async-result") {
			backgroundResultPending = true;
			checkpoints.outcome(true);
		}
	});
	pi.on("turn_end", (_event, ctx) => {
		if (ctx.agent.kind !== "main" || !controller.status().enabled) return;
		for (const [checkpointId, recovery] of recoveryTurns) {
			if (recovery.deadline <= currentTurn) {
				unresolved(checkpointId, "decision omitted after recovery turn");
				recoveryTurns.delete(checkpointId);
			}
		}
		if (timerInstructionDelivered) reminderClock.takeReminder();
	});
	pi.on("tool_execution_start", (event, ctx) => {
		if (ctx.agent.kind !== "main") return;
		if (event.toolName === "ask") userWaits.add(`ask:${event.toolCallId}`);
		if (!controller.status().enabled) {
			updateActivity(ctx);
			return;
		}
		const args = asRecord(event.args);
		if (args) {
			const target = canonicalToolTarget(event.toolName, args);
			const checkpoint = checkpoints.findTarget(target);
			const dispatch = dispatches.get(event.toolCallId);
			if (dispatch?.blockedCheckpointId !== undefined && dispatch.blockedCheckpointId === checkpoint?.id) {
				dispatches.delete(event.toolCallId);
			} else {
				dispatches.set(event.toolCallId, { target, checkpointId: checkpoint?.id });
				if (checkpoint?.decision === "pending" && checkpoint.recoveryAttempted) unresolved(checkpoint.id, "resubmitted without decision");
			}
			if (event.toolName === "plannotator" && (args.action === "review" || args.action === "annotate") && !checkpoint) {
				const revised = checkpoints.attention(target);
				if (revised) unresolved(revised.id, "review target changed after interception");
			}
		}
		updateActivity(ctx);
	});
	pi.on("tool_execution_end", (event, ctx) => {
		if (ctx.agent.kind !== "main") return;
		if (event.toolName === "ask") userWaits.delete(`ask:${event.toolCallId}`);
		const dispatch = dispatches.get(event.toolCallId);
		if (dispatch) {
			if (!dispatch.blockedCheckpointId) checkpoints.consumeTarget(dispatch.target);
			dispatches.delete(event.toolCallId);
		}
		updateActivity(ctx);
	});
	pi.on("tool_approval_requested", (event, ctx) => {
		if (ctx.agent.kind !== "main") return;
		userWaits.add(`approval:${event.toolCallId}`);
		if (!controller.status().enabled) {
			updateActivity(ctx);
			return;
		}
		const dispatch = dispatches.get(event.toolCallId);
		const checkpoint = dispatch?.checkpointId ? checkpoints.find(dispatch.checkpointId, "attention") : undefined;
		if (!checkpoint || checkpoint.decision === "pending") {
			const uncovered = checkpoints.attention(`approval:${event.toolName}:${event.toolCallId}`);
			if (uncovered) unresolved(uncovered.id, "approval target was not verifiable");
		}
		updateActivity(ctx);
	});
	pi.on("tool_approval_resolved", (event, ctx) => {
		if (ctx.agent.kind !== "main") return;
		userWaits.delete(`approval:${event.toolCallId}`);
		updateActivity(ctx);
	});
	pi.on("plan_review_requested", (event, ctx) => {
		if (ctx.agent.kind !== "main") return;
		userWaits.add(`plan:${event.reviewId}`);
		if (!controller.status().enabled) {
			updateActivity(ctx);
			return;
		}
		const target = canonicalPlanTarget(resolve(context.cwd, event.planFilePath), event.planContent);
		const checkpoint = checkpoints.findTarget(target) ?? checkpoints.attention(target);
		if (checkpoint?.decision === "pending") unresolved(checkpoint.id, "native review has no safe recovery point");
		checkpoints.consumeTarget(target);
		updateActivity(ctx);
	});
	pi.on("plan_review_resolved", (event, ctx) => {
		if (ctx.agent.kind !== "main") return;
		userWaits.delete(`plan:${event.reviewId}`);
		updateActivity(ctx);
	});
	pi.on("context", (event, ctx) => {
		if (ctx.agent.kind !== "main") return;
		updateActivity(ctx);
		let content = controller.status().enabled
			? "Speech: on. Session metadata, not a request. Answer the user, never this note."
			: "Speech: off. Session metadata, not a request. Answer the user, never this note. Do not call speak_notification.";
		if (controller.status().enabled && userWaits.size === 0) {
			const outcome = checkpoints.availableOutcome();
			const required = checkpoints.pendingOutcome();
			const reminder = reminderClock.peekReminder();
			if (required) content += ` Before finishing or asking for user action, record the pending outcome decision with checkpointId ${required.id}.`;
			else if (reminder !== undefined) {
				content += ` ${silenceReminder(reminder)}`;
				if (loopActive) timerInstructionDelivered = true;
			} else if (outcome?.decision === "pending") content += ` Current task outcome checkpointId ${outcome.id} is available only for purpose outcome and a substantial result. Routine work needs no decision. Attention needs an exact boundary or a requested attention checkpoint.`;
		}
		return { messages: [...event.messages, { role: "developer", content: [{ type: "text", text: content }], attribution: "agent", timestamp: Date.now() }] };
	});
	pi.on("tool_result", (event, ctx) => {
		if (ctx.agent.kind !== "main" || !controller.status().enabled) return;
		const details = asRecord(event.details);
		const xdev = details ? asRecord(details.xdev) : undefined;
		const toolName = typeof xdev?.tool === "string" ? xdev.tool : event.toolName;
		if (toolName === "speak_notification") return;
		workCalls++;
		checkpoints.availableOutcome();
		if (!event.isError && (toolName === "edit" || toolName === "write")) changedFiles = true;
		if (changedFiles || workCalls >= 3 || performance.now() - taskStarted >= 60_000) checkpoints.outcome();
	});
	pi.on("tool_call", (event, ctx) => {
		if (ctx.agent.kind !== "main" || !controller.status().enabled) return;
		const input = asRecord(event.input);
		if (!input) return;
		const isAsk = event.toolName === "ask";
		const isPlanReview = event.toolName === "plannotator" && (input.action === "review" || input.action === "annotate");
		if (!isAsk && !isPlanReview) return;
		const target = canonicalToolTarget(event.toolName, input);
		const checkpoint = checkpoints.attention(target);
		if (!checkpoint) return;
		if (checkpoint.decision !== "pending") {
			dispatches.set(event.toolCallId, { target, checkpointId: checkpoint.id });
			return;
		}
		const recovery = recoveryTurns.get(checkpoint.id);
		if (recovery) {
			if (recovery.deadline <= currentTurn && recovery.originCallId !== event.toolCallId) {
				unresolved(checkpoint.id, "decision omitted after recovery turn");
				recoveryTurns.delete(checkpoint.id);
				return;
			}
			dispatches.set(event.toolCallId, { target, checkpointId: checkpoint.id, blockedCheckpointId: checkpoint.id });
			return { block: true, reason: `${ATTENTION_RECOVERY} Checkpoint ID: ${checkpoint.id}` };
		}
		if (!checkpoints.markRecovery(checkpoint)) return;
		dispatches.set(event.toolCallId, { target, checkpointId: checkpoint.id, blockedCheckpointId: checkpoint.id });
		recoveryTurns.set(checkpoint.id, { deadline: currentTurn + 1, originCallId: event.toolCallId });
		return { block: true, reason: `${ATTENTION_RECOVERY} Checkpoint ID: ${checkpoint.id}` };
	});
	pi.on("session_stop", (event, ctx) => {
		if (ctx.agent.kind !== "main" || !controller.status().enabled) return;
		const candidate = backgroundResultPending || (workCalls > 0 && (changedFiles || workCalls >= 3 || performance.now() - taskStarted >= 60_000));
		if (!candidate) return;
		const outcome = checkpoints.outcome();
		if (!outcome || outcome.decision !== "pending") return;
		if (event.stop_hook_active || !checkpoints.markRecovery(outcome)) {
			unresolved(outcome.id, "decision omitted after recovery");
			return;
		}
		return { continue: true, additionalContext: `${OUTCOME_RECOVERY} Checkpoint ID: ${outcome.id}` };
	});
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
				checkpoints.enable();
				reminderClock.enable();
				updateActivity(ctx);
				notice(true);
			} else if (command === "off") {
				reminderClock.disable();
				checkpoints.disable();
				dispatches.clear();
				backgroundResultPending = false;
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
				pi.sendMessage({ customType: "speak-notifications-status", attribution: "agent", display: true, content: `Speech notifications: ${state.enabled ? "on" : "off"}\nPlayback: ${state.activePlayback ? "active" : "idle"}\nWaiting: ${state.queueDepth}/${state.queueLimit}\nUnresolved: ${checkpoints.unresolvedCount()}\n\n${configuration}${state.lastPlaybackError ? `\n\nPlayback error: ${state.lastPlaybackError}` : ""}` }, { triggerTurn: false });
			}
		}
	});
}

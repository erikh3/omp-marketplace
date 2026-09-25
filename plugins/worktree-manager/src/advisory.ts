import { realpath } from "node:fs/promises";
import { resolve } from "node:path";

import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";

import { parseDirectWorktreeCommands } from "./bash-policy.ts";
import { IncidentStore } from "./incident-store.ts";
import { isPathWithin } from "./validation.ts";
import type { PlacementPolicy } from "./backends.ts";
import type { WorktreeService } from "./worktree-service.ts";

const PENDING_TTL_MS = 5 * 60 * 1000;
const MAX_PENDING = 256;

interface Observation {
	repository: string;
	backend: string;
	policy: PlacementPolicy;
	path: string;
}

interface PendingObservation {
	observations: Observation[];
	timer: NodeJS.Timer;
}
function violatesPolicy(path: string, policy: PlacementPolicy): boolean {
	return policy.kind !== "local" || !isPathWithin(path, policy.managedRoot);
}

function formatReminder(observation: Observation, path: string): string {
	return [
		`[worktree-manager] Created worktree violates the configured ${observation.backend} placement policy.`,
		`Expected: ${observation.policy.expected}`,
		`Created: ${path}`,
		"Action: call worktree_manager with relocate to move this worktree now.",
	].join("\n");
}

/** Captures non-blocking direct worktree creations and persists mismatches after success. */
export class AdvisoryTracker {
	private readonly pending = new Map<string, PendingObservation>();

	constructor(
		private readonly service: WorktreeService,
		private readonly incidents: IncidentStore,
	) {}

	async observe(toolCallId: string, command: string, cwd: string, ctx: ExtensionContext): Promise<void> {
		const observations: Observation[] = [];
		for (const parsed of parseDirectWorktreeCommands(command, cwd)) {
			try {
				const placement = await this.service.placementForRepository(parsed.repositoryHint);
				const path = resolve(parsed.destination);
				if (!violatesPolicy(path, placement.policy)) continue;
				observations.push({
					repository: placement.repository,
					backend: placement.backend,
					policy: placement.policy,
					path,
				});
			} catch {
				// Advice never blocks or degrades the direct Git command.
			}
		}
		if (observations.length === 0) return;
		while (this.pending.size >= MAX_PENDING) {
			const oldest = this.pending.keys().next().value;
			if (oldest === undefined) break;
			this.remove(oldest, ctx);
		}
		const timer = ctx.setTimeout(() => {
			this.pending.delete(toolCallId);
		}, PENDING_TTL_MS);
		this.pending.set(toolCallId, { observations, timer });
	}

	async complete(toolCallId: string, isError: boolean, ctx: ExtensionContext): Promise<string | undefined> {
		const entry = this.pending.get(toolCallId);
		if (!entry) return undefined;
		this.remove(toolCallId, ctx);
		if (isError) return undefined;
		const reminders: string[] = [];
		for (const observation of entry.observations) {
			const path = await realpath(observation.path).catch(() => observation.path);
			await this.incidents.record({
				repository: observation.repository,
				path,
				backend: observation.backend,
				expected: observation.policy.expected,
				createdAt: new Date().toISOString(),
			});
			reminders.push(formatReminder(observation, path));
		}
		return reminders.join("\n\n");
	}

	clear(ctx: ExtensionContext): void {
		for (const toolCallId of this.pending.keys()) this.remove(toolCallId, ctx);
	}

	private remove(toolCallId: string, ctx: ExtensionContext): void {
		const entry = this.pending.get(toolCallId);
		if (!entry) return;
		ctx.clearTimer(entry.timer);
		this.pending.delete(toolCallId);
	}
}

export function relocationReminder(incident: { backend: string; expected: string; path: string }): string {
	return [
		`[worktree-manager] Unresolved ${incident.backend} placement incident.`,
		`Expected: ${incident.expected}`,
		`Created: ${incident.path}`,
		"Action: call worktree_manager with relocate to move this worktree now.",
	].join("\n");
}

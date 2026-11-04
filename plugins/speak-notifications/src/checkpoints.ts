import { createHash } from "node:crypto";

export type CheckpointPurpose = "outcome" | "attention";
export type Decision = "pending" | "speak" | "silent" | "unresolved";

/** A current notification boundary with its task and enablement ownership. */
export interface Checkpoint {
	id: string;
	purpose: CheckpointPurpose;
	decision: Decision;
	recoveryAttempted: boolean;
	taskGeneration: number;
	enablementGeneration: number;
	target?: string;
	unresolvedCause?: string;
}

const MAX_CHECKPOINTS = 16;

const MAX_RESOLVED_IDS = 32;

function stable(value: unknown, parents = new Set<object>()): string {
	if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
	if (typeof value === "number") {
		if (!Number.isFinite(value)) throw new TypeError("Tool boundary values must be finite JSON numbers.");
		return JSON.stringify(value);
	}
	if (typeof value !== "object") throw new TypeError("Tool boundary values must be JSON values.");
	if (parents.has(value)) throw new TypeError("Tool boundary values must not contain cycles.");
	parents.add(value);
	let serialized: string;
	if (Array.isArray(value)) serialized = `[${value.map(item => stable(item, parents)).join(",")}]`;
	else {
		const object = value as Record<string, unknown>;
		serialized = `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${stable(object[key], parents)}`).join(",")}}`;
	}
	parents.delete(value);
	return serialized;
}

function digest(value: string) {
	return createHash("sha256").update(value).digest("hex");
}

/** Removes host-generated call intent, which does not change a tool operation. */
function semanticToolInput(input: Record<string, unknown>) {
	const { i: _intent, ...semantic } = input;
	return semantic;
}

export function canonicalToolTarget(toolName: string, input: Record<string, unknown>) {
	return `tool:${toolName}:${digest(stable(semanticToolInput(input)))}`;
}

export function canonicalPlanTarget(path: string, content: string) {
	return `plan:${path}:${digest(content)}`;
}

export class Checkpoints {
	private readonly active = new Map<string, Checkpoint>();
	private readonly byTarget = new Map<string, string>();
	private nextId = 1;
	private taskGeneration = 0;
	private enablementGeneration = 0;
	private currentOutcome: Checkpoint | undefined;
	private outcomeRequired = false;
	private unresolved = 0;
	private readonly resolvedIds = new Map<string, CheckpointPurpose>();

	startTask() {
		this.taskGeneration++;
		this.clear();
	}

	enable() {
		this.enablementGeneration++;
		this.clear();
	}

	disable() {
		this.enablementGeneration++;
		this.clear();
	}

	epoch() {
		return `${this.taskGeneration}:${this.enablementGeneration}`;
	}

	availableOutcome() {
		if (this.currentOutcome && this.current(this.currentOutcome)) return this.currentOutcome;
		const checkpoint = this.create("outcome");
		if (checkpoint) this.currentOutcome = checkpoint;
		return checkpoint;
	}

	outcome(newEvidence = false) {
		this.outcomeRequired = true;
		if (!newEvidence && this.currentOutcome && this.current(this.currentOutcome)) return this.currentOutcome;
		if (newEvidence && this.currentOutcome?.decision === "pending") return this.currentOutcome;
		if (this.currentOutcome) this.retire(this.currentOutcome);
		const checkpoint = this.create("outcome");
		if (checkpoint) this.currentOutcome = checkpoint;
		return checkpoint;
	}

	attention(target: string) {
		const existingId = this.byTarget.get(target);
		const existing = existingId ? this.active.get(existingId) : undefined;
		if (existing && this.current(existing)) return existing;
		return this.create("attention", target);
	}

	find(id: string, purpose: CheckpointPurpose) {
		const checkpoint = this.active.get(id);
		return checkpoint?.purpose === purpose && this.current(checkpoint) ? checkpoint : undefined;
	}

	findTarget(target: string) {
		const id = this.byTarget.get(target);
		const checkpoint = id ? this.active.get(id) : undefined;
		return checkpoint && this.current(checkpoint) ? checkpoint : undefined;
	}

	isResolved(id: string, purpose: CheckpointPurpose) {
		return this.resolvedIds.get(id) === purpose;
	}

	pendingOutcome() {
		return this.outcomeRequired && this.currentOutcome?.decision === "pending" && this.current(this.currentOutcome) ? this.currentOutcome : undefined;
	}

	pendingRecoveredAttention() {
		for (const checkpoint of this.active.values()) {
			if (checkpoint.purpose === "attention" && checkpoint.decision === "pending" && checkpoint.recoveryAttempted && this.current(checkpoint)) return checkpoint;
		}
		return undefined;
	}

	consumeTarget(target: string) {
		const id = this.byTarget.get(target);
		this.byTarget.delete(target);
		if (!id) return;
		const checkpoint = this.active.get(id);
		if (checkpoint) this.retire(checkpoint);
	}

	discardTarget(target: string) {
		const id = this.byTarget.get(target);
		this.byTarget.delete(target);
		if (id) this.active.delete(id);
	}

	markRecovery(checkpoint: Checkpoint) {
		if (checkpoint.recoveryAttempted) return false;
		checkpoint.recoveryAttempted = true;
		return true;
	}

	markUnresolved(checkpoint: Checkpoint, cause: string) {
		if (checkpoint.decision !== "pending") return false;
		checkpoint.decision = "unresolved";
		checkpoint.unresolvedCause = cause;
		this.unresolved++;
		return true;
	}

	resolve(checkpoint: Checkpoint, decision: "speak" | "silent") {
		if (checkpoint.decision === decision) return "duplicate" as const;
		if (checkpoint.decision !== "pending") return "stale" as const;
		checkpoint.decision = decision;
		return "accepted" as const;
	}

	unresolvedCount() {
		return this.unresolved;
	}

	private create(purpose: CheckpointPurpose, target?: string) {
		if (this.active.size >= MAX_CHECKPOINTS) return undefined;
		const checkpoint: Checkpoint = {
			id: `speech-${this.taskGeneration}-${this.enablementGeneration}-${this.nextId++}`,
			purpose,
			decision: "pending",
			recoveryAttempted: false,
			taskGeneration: this.taskGeneration,
			enablementGeneration: this.enablementGeneration,
			target
		};
		this.active.set(checkpoint.id, checkpoint);
		if (target) this.byTarget.set(target, checkpoint.id);
		return checkpoint;
	}

	private clear() {
		this.active.clear();
		this.byTarget.clear();
		this.currentOutcome = undefined;
		this.outcomeRequired = false;
		this.unresolved = 0;
		this.resolvedIds.clear();
	}

	private retire(checkpoint: Checkpoint) {
		this.active.delete(checkpoint.id);
		if (checkpoint.target && this.byTarget.get(checkpoint.target) === checkpoint.id) this.byTarget.delete(checkpoint.target);
		if (checkpoint.decision !== "speak" && checkpoint.decision !== "silent") return;
		this.resolvedIds.delete(checkpoint.id);
		this.resolvedIds.set(checkpoint.id, checkpoint.purpose);
		if (this.resolvedIds.size > MAX_RESOLVED_IDS) this.resolvedIds.delete(this.resolvedIds.keys().next().value!);
	}

	private current(checkpoint: Checkpoint) {
		return checkpoint.taskGeneration === this.taskGeneration && checkpoint.enablementGeneration === this.enablementGeneration;
	}
}

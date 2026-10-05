import type { BlockRule, ToolStartInfo } from "./rules/types.ts";

/** Emits `{ active, label }` on the shared `herdr:blocked` bus channel. */
export type BlockSignal = (active: boolean, label?: string) => void;

/**
 * Owns block lifecycle for a set of rules. Runs every rule on each tool start so
 * stateful rules observe all calls, opens at most one block per `toolCallId`
 * (first matching rule's label wins), and emits one `active:true` on open and one
 * `active:false` on close. That 1:1 pairing matches the ref-count the
 * Herdr-managed omp integration keeps for the `herdr:blocked` channel.
 */
export class BlockEngine {
	readonly #rules: readonly BlockRule[];
	readonly #signal: BlockSignal;
	// toolCallId -> label, for calls we have reported as blocked.
	readonly #open = new Map<string, string>();

	constructor(rules: readonly BlockRule[], signal: BlockSignal) {
		this.#rules = rules;
		this.#signal = signal;
	}

	onToolStart(event: ToolStartInfo): void {
		let label: string | undefined;
		for (const rule of this.#rules) {
			const ruleLabel = rule.onToolStart(event);
			// Keep running later rules for their side effects, but the first
			// non-empty label is the one we report.
			if (label === undefined && ruleLabel !== undefined && ruleLabel !== "") {
				label = ruleLabel;
			}
		}
		if (label === undefined) return;
		if (this.#open.has(event.toolCallId)) return;
		this.#open.set(event.toolCallId, label);
		this.#signal(true, label);
	}

	onToolEnd(toolCallId: string): void {
		if (!this.#open.delete(toolCallId)) return;
		this.#signal(false);
	}

	/** Clear every outstanding block, e.g. on session shutdown. */
	clear(): void {
		for (const _ of this.#open) this.#signal(false);
		this.#open.clear();
	}

	/** Number of currently open blocks (test seam). */
	get openCount(): number {
		return this.#open.size;
	}
}

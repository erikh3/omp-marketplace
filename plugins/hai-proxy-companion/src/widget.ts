import type { Theme } from "@oh-my-pi/pi-coding-agent";
import type { Component } from "@oh-my-pi/pi-tui";

export interface WidgetState {
	sessionEstimateEur: number;
	dailyEstimateEur: number;
	monthlyEstimateEur: number;
	dailyBudgetEur: number;
	monthlyBudgetEur: number;
	contextTokens?: number;
	contextGrowthTokens?: number;
	capHitAt?: string;
}

export class CompanionWidget implements Component {
	#state: WidgetState;
	readonly #theme: Theme;

	constructor(theme: Theme, state: WidgetState) {
		this.#theme = theme;
		this.#state = state;
	}

	setState(state: WidgetState): void {
		this.#state = state;
	}

	render(_width: number): readonly string[] {
		if (this.#state.capHitAt) return [this.#theme.fg("error", "HAI: daily cap hit. The wallet has requested a lie-down.")];
		const context = this.#state.contextTokens === undefined ? "" : ` · ctx ${(this.#state.contextTokens / 1_000).toFixed(0)}k`;
		const growth = this.#state.contextGrowthTokens && this.#state.contextGrowthTokens > 0 ? ` (+${(this.#state.contextGrowthTokens / 1_000).toFixed(0)}k)` : "";
		const dailyPercent = Math.round(this.#state.dailyEstimateEur / this.#state.dailyBudgetEur * 100);
		const monthlyPercent = Math.round(this.#state.monthlyEstimateEur / this.#state.monthlyBudgetEur * 100);
		return [this.#theme.fg("muted", `HAI ~€${this.#state.sessionEstimateEur.toFixed(2)} session · ~€${this.#state.dailyEstimateEur.toFixed(2)}/${this.#state.dailyBudgetEur} today (${dailyPercent}%) · ~€${this.#state.monthlyEstimateEur.toFixed(2)}/${this.#state.monthlyBudgetEur} month (${monthlyPercent}%)${context}${growth}`)];
	}
}

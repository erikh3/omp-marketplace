/** Session-local cooldown clock for autonomous speech reminders. */

/**
 * Time and timer operations used by {@link ReminderClock}.
 *
 * Supplying this interface makes timing behavior deterministic in tests without
 * coupling the clock to an OMP runtime.
 */
export interface ReminderClockScheduler {
	/** Returns the current monotonic time in milliseconds. */
	now(): number;
	/** Schedules a one-shot callback after `delayMs` milliseconds. */
	setTimeout(callback: () => void, delayMs: number): unknown;
	/** Cancels a previously scheduled callback. */
	clearTimeout(handle: unknown): void;
}

const systemScheduler: ReminderClockScheduler = {
	now: () => performance.now(),
	setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
	clearTimeout: (handle) => clearTimeout(handle as number),
};

/**
 * Tracks silence between successful speech completions and exposes one
 * coalesced reminder when the configured cooldown expires.
 */
export class ReminderClock {
	private enabled = false;
	private baseline = 0;
	private due = false;
	private timer: unknown | undefined;
	private generation = 0;

	/**
	 * Creates a reminder clock.
	 *
	 * @param intervalMs Cooldown duration in milliseconds.
	 * @param scheduler Optional time source and timer implementation.
	 */
	constructor(
		private readonly intervalMs = 300_000,
		private readonly scheduler: ReminderClockScheduler = systemScheduler,
	) {}

	/** Enables the clock and starts a fresh cooldown. */
	enable(): void {
		if (this.enabled) return;

		this.enabled = true;
		this.baseline = this.scheduler.now();
		this.due = false;
		this.arm();
	}

	/** Disables the clock, clears all pending state, and freezes elapsed time. */
	disable(): void {
		this.enabled = false;
		this.baseline = 0;
		this.due = false;
		this.cancelTimer();
	}

	/** Pauses the cooldown while owned speech synthesis or playback is active. */
	playbackStarted(): void {
		if (!this.enabled) return;

		this.due = false;
		this.cancelTimer();
	}

	/**
	 * Resumes the cooldown after playback.
	 *
	 * A successful completion starts a new silence period. A failure retains the
	 * previous silence baseline, but waits a full cooldown before another
	 * reminder so repeated failures cannot cause reminder spam.
	 */
	playbackFinished(success: boolean): void {
		if (!this.enabled) return;

		this.due = false;
		if (success) this.baseline = this.scheduler.now();
		this.arm();
	}

	/**
	 * Consumes the pending reminder, returning elapsed silence in milliseconds.
	 * Returns `undefined` unless the cooldown has expired while enabled.
	 */
	takeReminder(): number | undefined {
		if (!this.enabled || !this.due) return undefined;

		this.due = false;
		const elapsed = this.scheduler.now() - this.baseline;
		this.arm();
		return elapsed;
	}

	/** Releases timer resources and resets the clock. */
	dispose(): void {
		this.disable();
	}

	private arm(): void {
		this.cancelTimer();
		const generation = this.generation;
		const handle = this.scheduler.setTimeout(() => {
			if (!this.enabled || generation !== this.generation) return;

			this.timer = undefined;
			this.due = true;
		}, this.intervalMs);
		this.timer = handle;
		const timer = handle as { unref?: () => void };
		timer.unref?.();
	}

	private cancelTimer(): void {
		this.generation += 1;
		if (this.timer === undefined) return;

		this.scheduler.clearTimeout(this.timer);
		this.timer = undefined;
	}
}

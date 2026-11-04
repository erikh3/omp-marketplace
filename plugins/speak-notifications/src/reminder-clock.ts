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
 * Tracks active work between successful speech completions and exposes one
 * coalesced reminder when the configured cooldown expires.
 */
export class ReminderClock {
	private enabled = false;
	private working = false;
	private waiting = false;
	private playing = false;
	private elapsed = 0;
	private remaining: number;
	private activeSince: number | undefined;
	private due = false;
	private timer: unknown | undefined;
	private generation = 0;

	/** Creates an active-work reminder clock. */
	constructor(
		private readonly intervalMs = 300_000,
		private readonly scheduler: ReminderClockScheduler = systemScheduler,
	) {
		this.remaining = intervalMs;
	}

	/** Enables a fresh cooldown, which runs only during active work. */
	enable(): void {
		if (this.enabled) return;
		this.enabled = true;
		this.elapsed = 0;
		this.remaining = this.intervalMs;
		this.due = false;
		this.resumeIfActive();
	}

	/** Disables the clock and makes the next enable start a full interval. */
	disable(): void {
		this.pause();
		this.enabled = false;
		this.playing = false;
		this.elapsed = 0;
		this.remaining = this.intervalMs;
		this.due = false;
		this.cancelTimer();
	}

	/** Marks model, foreground, or background work active or idle. */
	setWorking(working: boolean): void {
		if (this.working === working) return;
		this.pause();
		this.working = working;
		this.resumeIfActive();
	}

	/** Marks a user decision or question wait, which pauses active-work time. */
	setWaiting(waiting: boolean): void {
		if (this.waiting === waiting) return;
		this.pause();
		this.waiting = waiting;
		this.resumeIfActive();
	}

	/** Pauses active-work time while owned speech is queued, synthesized, or played. */
	playbackStarted(): void {
		if (!this.enabled || this.playing) return;
		this.pause();
		this.playing = true;
	}

	/**
	 * Ends owned speech. Success starts a fresh interval; failure preserves
	 * elapsed active silence but defers reassessment by a full active interval.
	 */
	playbackFinished(success: boolean): void {
		if (!this.enabled || !this.playing) return;
		this.pause();
		this.playing = false;
		this.due = false;
		if (success) this.elapsed = 0;
		this.remaining = this.intervalMs;
		this.resumeIfActive();
	}

	/** Returns the pending reminder without consuming or rearming it. */
	peekReminder(): number | undefined {
		return this.enabled && this.due && this.isActive() ? this.elapsed : undefined;
	}

	/** Consumes one pending reminder during active, non-waiting, non-speech work. */
	takeReminder(): number | undefined {
		if (!this.enabled || !this.due || !this.isActive()) return undefined;
		this.pause();
		this.due = false;
		this.remaining = this.intervalMs;
		this.resumeIfActive();
		return this.elapsed;
	}

	/** Releases timer resources and resets the clock. */
	dispose(): void { this.disable(); }

	private isActive(): boolean {
		return this.enabled && this.working && !this.waiting && !this.playing;
	}

	private pause(): void {
		if (this.activeSince !== undefined) {
			const activeFor = this.scheduler.now() - this.activeSince;
			this.elapsed += activeFor;
			this.remaining = Math.max(0, this.remaining - activeFor);
			this.activeSince = undefined;
		}
		this.cancelTimer();
	}

	private resumeIfActive(): void {
		if (!this.isActive() || this.activeSince !== undefined) return;
		this.activeSince = this.scheduler.now();
		if (!this.due) this.arm();
	}

	private arm(): void {
		this.cancelTimer();
		const generation = this.generation;
		const handle = this.scheduler.setTimeout(() => {
			if (!this.isActive() || generation !== this.generation) return;
			this.timer = undefined;
			const now = this.scheduler.now();
			this.elapsed += now - (this.activeSince ?? now);
			this.activeSince = now;
			this.remaining = 0;
			this.due = true;
		}, this.remaining);
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

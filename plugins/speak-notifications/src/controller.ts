/** Session-local priority queue and owned playback lifecycle. */

import type { Playback } from "./playback.ts";

export type NotificationPurpose = "outcome" | "attention" | "milestone";

/** Waiting speech with host-owned task identity, separate from active playback. */
interface QueuedNotification {
	text: string;
	purpose: NotificationPurpose;
	task: number;
}

/** Synchronous result returned by {@link NotificationController.enqueue}. */
export interface EnqueueResult {
	/** Whether the text was accepted and queued for playback. */
	accepted: boolean;
	/** Human-readable acceptance confirmation or rejection reason. */
	message: string;
	/**
	 * One-based position of this item in the waiting queue at enqueue time.
	 * Excludes current playback.  Present only when `accepted` is `true`.
	 */
	position?: number;
	/**
	 * Total waiting queue depth at enqueue time.
	 * Excludes current playback.  Present only when `accepted` is `true`.
	 */
	depth?: number;
	/** Previously queued milestone texts removed by this acceptance; they will not play. */
	superseded?: string[];
}

/** Session-state snapshot returned by {@link NotificationController.status}. */
export interface NotificationState {
	enabled: boolean;
	/** True throughout an owned synthesis/playback process's lifetime. */
	activePlayback: boolean;
	/** Number of messages waiting in the queue, excluding current playback. */
	queueDepth: number;
	/** Maximum waiting queue capacity (always 3). */
	queueLimit: number;
	/**
	 * Latest playback error, retained until a successful uninterrupted playback
	 * clears it or the session ends.  Not cleared by toggling notifications.
	 */
	lastPlaybackError: string | null;
}

/** Exact response returned when the controller is disabled. */
export const DISABLED_MESSAGE =
	"Speech notifications are disabled. Do not retry unless the user enables them with /speak on.";

const QUEUE_LIMIT = 3;

/** Validates speak text without inspecting session queue capacity. */
export function validateNotificationText(text: string): EnqueueResult {
	if (/\p{Cc}/u.test(text)) return { accepted: false, message: "Notification text contains a Unicode Cc control character (e.g. newline, tab). Remove control characters before calling." };
	const trimmed = text.trim();
	if (trimmed.length === 0) return { accepted: false, message: "Notification text is empty after trimming." };
	let codePoints = 0;
	for (const _character of trimmed) if (++codePoints > 500) break;
	if (codePoints > 500) return { accepted: false, message: "Notification text exceeds the 500 code-point limit after trimming." };
	return { accepted: true, message: trimmed };
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Manages attention-first waiting speech with a single serial playback worker.
 *
 * Enqueue is synchronous and returns immediately.  The worker starts via
 * `queueMicrotask` so a rapid burst of enqueue() calls can fill the full
 * waiting capacity before the worker dequeues the first item.
 *
 * State is entirely session-local and in-memory; nothing is persisted.
 */
export class NotificationController {
	private readonly startPlaybackFn: (text: string) => Playback;
	private readonly reportErrorFn: (message: string) => void;

	private enabled = false;
	private activePlayback = false;
	private readonly queue: QueuedNotification[] = [];
	private lastPlaybackError: string | null = null;
	private currentPlayback: Playback | undefined;
	private workerRunning = false;
	/**
	 * Set synchronously by disable/reset/shutdown before any `await`.
	 * When true the worker treats the in-progress exited result as a deliberate
	 * state change: it neither clears `lastPlaybackError` on resolve nor records
	 * a new error on reject.
	 */
	private currentPlaybackStopped = false;

	constructor(
		startPlayback: (text: string) => Playback,
		reportError: (message: string) => void,
		private readonly playbackFinished: (success: boolean) => void = () => {},
	) {
		this.startPlaybackFn = startPlayback;
		this.reportErrorFn = reportError;
	}

	/**
	 * Validates and enqueues `text`.  Returns immediately without awaiting synthesis.
	 *
	 * Validation order (while enabled):
	 * 1. Unicode Cc control characters checked on original text before trim.
	 * 2. Trim leading/trailing whitespace.
	 * 3. Reject empty text after trim.
	 * 4. Reject text exceeding 500 Unicode code points.
	 * 5. Apply capacity after prospective milestone supersession (3 waiting).
	 */
	enqueue(text: string, purpose: NotificationPurpose, task: number): EnqueueResult {
		if (!this.enabled) {
			return { accepted: false, message: DISABLED_MESSAGE };
		}

		const textValidation = validateNotificationText(text);
		if (!textValidation.accepted) return textValidation;
		const trimmed = textValidation.message;

		const superseded: string[] = [];
		for (const item of this.queue) {
			if (item.purpose === "milestone" && (purpose === "milestone" || (purpose === "outcome" && item.task === task))) superseded.push(item.text);
		}
		// Reject atomically: obsolete progress is removed only when its replacement is admitted.
		if (this.queue.length - superseded.length >= QUEUE_LIMIT) {
			return { accepted: false, message: "Notification queue is full (3 waiting); this notification was not spoken." };
		}
		if (superseded.length > 0) {
			for (let index = this.queue.length - 1; index >= 0; index--) {
				const item = this.queue[index];
				if (item.purpose === "milestone" && (purpose === "milestone" || (purpose === "outcome" && item.task === task))) this.queue.splice(index, 1);
			}
		}
		let index = this.queue.length;
		if (purpose === "attention") {
			index = 0;
			while (index < this.queue.length && this.queue[index].purpose === "attention") index++;
		}
		this.queue.splice(index, 0, { text: trimmed, purpose, task });
		const position = index + 1;
		const depth = this.queue.length;

		// Start the worker via microtask so a rapid burst of enqueue() calls fills
		// the waiting capacity before the worker dequeues the first item.
		queueMicrotask(() => {
			void this.runWorker();
		});

		return {
			accepted: true,
			message: `Queued at waiting position ${position} of ${depth}.${superseded.length > 0 ? ` Superseded ${superseded.length} waiting milestone(s); they will not play.` : ""}`,
			position,
			depth,
			...(superseded.length > 0 ? { superseded } : {})
		};
	}

	/** Enables speech notifications for this session. */
	enable(): void {
		this.enabled = true;
	}

	/**
	 * Disables speech notifications.  Clears the waiting queue and stops any
	 * owned synthesis/playback process.  Returns after the process has exited.
	 * Explicit termination is not recorded as a playback error.
	 */
	async disable(): Promise<void> {
		this.enabled = false;
		this.queue.length = 0;
		await this.stopCurrentPlayback();
	}

	/**
	 * Stops any owned playback and reinitializes all session state to defaults.
	 * Does not return until the previous playback has fully exited.
	 *
	 * The queue is cleared before stopping so the worker does not dequeue a new
	 * item between the stop signal and the exit acknowledgement.  All other state
	 * is reset only after the stop completes.
	 */
	async reset(): Promise<void> {
		this.queue.length = 0;
		await this.stopCurrentPlayback();
		this.enabled = false;
		this.activePlayback = false;
		this.currentPlayback = undefined;
		this.lastPlaybackError = null;
		this.workerRunning = false;
		this.currentPlaybackStopped = false;
	}

	/**
	 * Clears the waiting queue and stops owned playback for session shutdown.
	 * Returns after the process has exited.
	 */
	async shutdown(): Promise<void> {
		this.enabled = false;
		this.queue.length = 0;
		await this.stopCurrentPlayback();
	}

	/** Returns a point-in-time snapshot of notification state. */
	status(): NotificationState {
		return {
			enabled: this.enabled,
			activePlayback: this.activePlayback,
			queueDepth: this.queue.length,
			queueLimit: QUEUE_LIMIT,
			lastPlaybackError: this.lastPlaybackError,
		};
	}

	/**
	 * Stops the current playback if one is running and awaits its exit.
	 * `currentPlaybackStopped` is set synchronously before the first `await`
	 * so the worker always observes it when it resumes.
	 */
	private async stopCurrentPlayback(): Promise<void> {
		const prev = this.currentPlayback;
		if (!prev) return;
		this.currentPlaybackStopped = true;
		await prev.stop();
		// Await exited separately: stop() may return before the process fully exits,
		// and the caller contract (disable/reset/shutdown) requires waiting for the
		// owned exit.  Catch guards against a residual rejection from an edge case.
		await prev.exited.catch(() => {});
	}

	private async runWorker(): Promise<void> {
		if (this.workerRunning) return;
		this.workerRunning = true;

		while (this.queue.length > 0) {
			const { text } = this.queue.shift()!;

			let playback: Playback;
			try {
				playback = this.startPlaybackFn(text);
			} catch (error) {
				// A synchronous spawn failure is a playback failure.
				this.lastPlaybackError = errorMessage(error);
				this.reportErrorFn(`speak_notification: playback failed: ${this.lastPlaybackError}`);
				this.playbackFinished(false);
				continue;
			}

			this.activePlayback = true;
			this.currentPlayback = playback;
			// Reset per-playback stop flag synchronously before the yield.
			// disable/reset/shutdown only run after a yield and will always see
			// false here before they set it to true.
			this.currentPlaybackStopped = false;

			let succeeded = false;
			try {
				await playback.exited;
				// Clear the retained error only on a genuine uninterrupted success.
				// An explicit stop also resolves exited cleanly, so the flag guards
				// against clearing lastPlaybackError in that case.
				if (!this.currentPlaybackStopped) {
					this.lastPlaybackError = null;
					succeeded = true;
				}
			} catch (error) {
				// Do not record an error for an explicitly stopped playback.
				if (!this.currentPlaybackStopped) {
					this.lastPlaybackError = errorMessage(error);
					this.reportErrorFn(`speak_notification: playback failed: ${this.lastPlaybackError}`);
				}
			}

			this.activePlayback = false;
			this.currentPlayback = undefined;
			this.playbackFinished(succeeded);
		}

		this.workerRunning = false;
	}
}

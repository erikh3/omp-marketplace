import { spawn } from "node:child_process";

/**
 * A handle to an in-flight or finished local TTS playback process.
 *
 * `exited` resolves when the process exits with code 0, and rejects on a
 * nonzero exit or spawn error.  A `stop()` call resolves `exited` without
 * error regardless of when the process is terminated.
 */
export interface Playback {
	/** Resolves on clean exit; rejects with captured stderr or code summary on failure. */
	readonly exited: Promise<void>;
	/**
	 * Sends SIGTERM to the entire process group and awaits exit.
	 * Explicit termination is a normal state change, never a playback failure.
	 * Safe to call after the process has already exited.
	 */
	stop(): Promise<void>;
}

/**
 * Resolved local TTS parameters and execution context passed to `omp say`.
 *
 * All values must be obtained from the parent session's live settings and
 * model registry -- never from independently loaded persisted configuration.
 */
export interface LocalPlaybackOptions {
	/** Resolved local TTS model ID from the parent session's speech-role candidate chain. */
	model: string;
	/** Resolved local voice ID from the parent session's `tts.localVoice` setting. */
	voice: string;
	/** Resolved playback speed from the parent session's `tts.localSpeed` setting. */
	speed: number;
	/** Working directory for the spawned `omp say` process. */
	cwd: string;
}

/** Maximum bytes of stderr retained for error messages. */
const STDERR_LIMIT = 4096;

/**
 * Spawns `omp say` in its own process group and returns a {@link Playback} handle.
 *
 * The child is spawned with `detached: true` (POSIX `setsid`), making it the
 * leader of a new process group.  {@link Playback.stop} sends `SIGTERM` to
 * `-pgid` so any synthesis descendants are also terminated.
 *
 * The `close` event (not `exit`) settles `exited` so stderr is fully drained
 * before the rejection message is assembled.  Only ESRCH is suppressed in
 * `stop()`; other kill errors propagate.  The `completed` flag prevents
 * `stop()` from sending SIGTERM to a reused PID after natural process exit.
 *
 * @param text        - Plain text to synthesize and play.
 * @param options     - Resolved local TTS parameters and working directory.
 * @param _executable - Override binary path (narrow test seam; production default: `"omp"`).
 */
export function startLocalPlayback(
	text: string,
	options: LocalPlaybackOptions,
	_executable?: string,
): Playback {
	const { model, voice, speed, cwd } = options;
	const executable = _executable ?? "omp";
	const args = ["say", "--model", model, "--voice", voice, "--speed", String(speed), "--", text];

	let stopped = false;
	let completed = false;
	const stderrChunks: Buffer[] = [];
	let stderrSize = 0;

	const proc = spawn(executable, args, {
		cwd,
		detached: true,
		stdio: ["ignore", "ignore", "pipe"],
	});

	proc.stderr?.on("data", (chunk: Buffer) => {
		const remaining = STDERR_LIMIT - stderrSize;
		if (remaining > 0) {
			stderrChunks.push(chunk.subarray(0, remaining));
			stderrSize += Math.min(chunk.length, remaining);
		}
	});

	const { promise: exited, resolve, reject } = Promise.withResolvers<void>();

	// Use 'close' (not 'exit') so stderr is fully drained before we read it.
	proc.on("close", (code, signal) => {
		completed = true;
		if (stopped) {
			// Explicit termination is a normal state change, not a failure.
			resolve();
			return;
		}
		if (code === 0) {
			resolve();
		} else {
			const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
			reject(
				new Error(
					stderr ||
					`omp say exited with code ${code ?? "null"}, signal ${signal ?? "none"}`,
				),
			);
		}
	});

	// 'error' handles spawn failures (ENOENT etc.) before 'close' can fire.
	proc.on("error", (err) => {
		reject(err);
	});

	async function stop(): Promise<void> {
		// Set flag synchronously before any await so the close handler sees it.
		stopped = true;
		// Guard against killing a reused PID after natural process exit.
		if (proc.pid !== undefined && !completed) {
			try {
				process.kill(-proc.pid, "SIGTERM");
			} catch (err) {
				// ESRCH = process group already gone; suppress only that.
				if ((err as NodeJS.ErrnoException).code !== "ESRCH") throw err;
			}
		}
		await exited.catch(() => {
			// Cancellation resolves cleanly; suppress any in-flight rejection.
		});
	}

	return { exited, stop };
}

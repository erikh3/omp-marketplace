/**
 * NotificationController unit tests.
 *
 * All async work uses controlled promises rather than timing sleeps.
 * `tick()` drains the microtask queue by awaiting a resolved Promise so
 * any worker continuations triggered by a settled playback run to completion
 * before the next assertion.
 *
 * The mock stop() resolves `exited` automatically, mirroring the real
 * startLocalPlayback implementation where explicit termination is a normal
 * state change.
 */

import { afterEach, describe, expect, test } from "bun:test";
import type { Playback } from "../src/playback.ts";
import { DISABLED_MESSAGE, NotificationController } from "../src/controller.ts";
import type { NotificationState } from "../src/controller.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Advance the microtask queue once. */
function tick(): Promise<void> {
	return Promise.resolve();
}

interface ControlledPlayback {
	readonly playback: Playback;
	readonly text: string;
	/** Resolve exited as a natural success. */
	resolve(): void;
	/** Reject exited with an error, simulating a process failure. */
	reject(error: Error): void;
}

/**
 * Returns a Playback whose stop() auto-resolves exited (mirroring the real
 * implementation) and whose exited can also be settled manually via the
 * returned resolve/reject handles.
 */
function makeControlledPlayback(text: string): ControlledPlayback {
	const { promise: exited, resolve: resolveExited, reject: rejectExited } = Promise.withResolvers<void>();
	const playback: Playback = {
		exited,
		async stop() {
			// Mirror real behaviour: explicit termination resolves exited cleanly.
			resolveExited();
		},
	};
	return { playback, text, resolve: resolveExited, reject: rejectExited };
}

interface ControlledController {
	controller: NotificationController;
	playbacks: ControlledPlayback[];
	errors: string[];
	completed: boolean[];
}

/** Factory used by most tests. Collects playback starts, errors, and outcomes. */
function makeController(): ControlledController {
	const playbacks: ControlledPlayback[] = [];
	const errors: string[] = [];
	const completed: boolean[] = [];
	const controller = new NotificationController(
		(text) => {
			const cp = makeControlledPlayback(text);
			playbacks.push(cp);
			return cp.playback;
		},
		(msg) => {
			errors.push(msg);
		},
		(success) => {
			completed.push(success);
		},
	);
	return { controller, playbacks, errors, completed };
}

// ---------------------------------------------------------------------------
// Resolve pending controlled playbacks after each test to
// prevent dangling microtasks from leaking into subsequent tests.
// ---------------------------------------------------------------------------

const pendingPlaybacks: ControlledPlayback[] = [];
afterEach(async () => {
	for (const cp of pendingPlaybacks.splice(0)) {
		cp.resolve();
	}
	await tick();
});

// ---------------------------------------------------------------------------
// 1. Disabled validation precedence
// ---------------------------------------------------------------------------

describe("disabled validation precedence", () => {
	test("returns exact disabled message for any schema-valid call without validating text", () => {
		const { controller } = makeController();
		// Disabled takes precedence over control-character validation.
		expect(controller.enqueue("\x01 hello", "outcome", 0)).toEqual({
			accepted: false,
			message: DISABLED_MESSAGE,
		});
		// Disabled takes precedence over blank-text validation.
		expect(controller.enqueue("   ", "outcome", 0)).toEqual({
			accepted: false,
			message: DISABLED_MESSAGE,
		});
		// Disabled takes precedence over the length limit.
		expect(controller.enqueue("a".repeat(501), "outcome", 0)).toEqual({
			accepted: false,
			message: DISABLED_MESSAGE,
		});
	});

	test("validation runs only once enabled", () => {
		const { controller } = makeController();
		controller.enable();
		const result = controller.enqueue("\x01 hello", "outcome", 0);
		expect(result.accepted).toBe(false);
		expect(result.message).not.toBe(DISABLED_MESSAGE);
	});
});

// ---------------------------------------------------------------------------
// 2. Unicode Cc before trim and 500-code-point boundary
// ---------------------------------------------------------------------------

describe("unicode Cc and code-point validation", () => {
	test("rejects tab (U+0009, Cc) before trim is applied", () => {
		const { controller } = makeController();
		controller.enable();
		// "\t" alone would be empty after trim, but the Cc check comes first.
		const result = controller.enqueue("\t", "outcome", 0);
		expect(result.accepted).toBe(false);
		expect(result.message).not.toBe(DISABLED_MESSAGE);
		expect(result.message).not.toContain("empty"); // Cc error, not empty error
	});

	test("rejects text with leading tab even when remainder is valid", () => {
		const { controller } = makeController();
		controller.enable();
		const result = controller.enqueue("\thello", "outcome", 0);
		expect(result.accepted).toBe(false);
		expect(result.message).not.toBe(DISABLED_MESSAGE);
		expect(result.message).not.toContain("empty");
	});

	test("rejects embedded newline (U+000A, Cc)", () => {
		const { controller } = makeController();
		controller.enable();
		expect(controller.enqueue("hello\nworld", "outcome", 0).accepted).toBe(false);
	});

	test("rejects NUL (U+0000, Cc)", () => {
		const { controller } = makeController();
		controller.enable();
		expect(controller.enqueue("hel\x00lo", "outcome", 0).accepted).toBe(false);
	});

	test("accepts exactly 500 code points and returns correct position/depth", () => {
		const { controller } = makeController();
		controller.enable();
		const result = controller.enqueue("a".repeat(500), "outcome", 0);
		expect(result.accepted).toBe(true);
		expect(result.position).toBe(1);
		expect(result.depth).toBe(1);
	});

	test("rejects 501 code points", () => {
		const { controller } = makeController();
		controller.enable();
		const result = controller.enqueue("a".repeat(501), "outcome", 0);
		expect(result.accepted).toBe(false);
		expect(result.message).not.toBe(DISABLED_MESSAGE);
	});

	test("counts multi-byte emoji as 1 code point each", () => {
		const { controller } = makeController();
		controller.enable();
		// U+1F600 is 1 code point but 2 UTF-16 units.
		const exactly500 = "😀".repeat(499) + "x"; // 500 code points
		expect(controller.enqueue(exactly500, "outcome", 0).accepted).toBe(true);
	});

	test("rejects 501 code points including emoji", () => {
		const { controller } = makeController();
		controller.enable();
		const over500 = "😀".repeat(501); // 501 code points
		expect(controller.enqueue(over500, "outcome", 0).accepted).toBe(false);
	});

	test("trims and accepts; code-point limit applies to trimmed text", () => {
		const { controller } = makeController();
		controller.enable();
		expect(controller.enqueue("  hello world  ", "outcome", 0).accepted).toBe(true);
	});

	test("rejects text empty after trimming", () => {
		const { controller } = makeController();
		controller.enable();
		const result = controller.enqueue("   ", "outcome", 0);
		expect(result.accepted).toBe(false);
		expect(result.message).not.toBe(DISABLED_MESSAGE);
		expect(result.message).toContain("empty");
	});
});

// ---------------------------------------------------------------------------
// 3. Commands: enable / disable / reset
// ---------------------------------------------------------------------------

describe("commands: enable, disable, reset", () => {
	test("initial state is disabled", () => {
		const { controller } = makeController();
		const s: NotificationState = controller.status();
		expect(s.enabled).toBe(false);
		expect(s.activePlayback).toBe(false);
		expect(s.queueDepth).toBe(0);
		expect(s.queueLimit).toBe(3);
		expect(s.lastPlaybackError).toBeNull();
	});

	test("enable sets enabled=true and allows enqueue", () => {
		const { controller } = makeController();
		controller.enable();
		expect(controller.status().enabled).toBe(true);
		expect(controller.enqueue("hello", "outcome", 0).accepted).toBe(true);
	});

	test("disable sets enabled=false and clears waiting queue", async () => {
		const { controller } = makeController();
		controller.enable();
		controller.enqueue("one", "outcome", 0);
		controller.enqueue("two", "outcome", 0);
		expect(controller.status().queueDepth).toBe(2);

		await controller.disable();

		expect(controller.status().enabled).toBe(false);
		expect(controller.status().queueDepth).toBe(0);
	});

	test("disable stops active playback and returns after exit", async () => {
		const { controller, playbacks } = makeController();
		controller.enable();
		controller.enqueue("hello", "outcome", 0);
		await tick(); // worker starts

		expect(playbacks).toHaveLength(1);
		expect(controller.status().activePlayback).toBe(true);

		await controller.disable(); // stop() auto-resolves exited

		expect(controller.status().activePlayback).toBe(false);
		expect(controller.status().enabled).toBe(false);
	});

	test("reset reinitializes all state after stopping playback", async () => {
		const { controller, playbacks } = makeController();
		controller.enable();
		controller.enqueue("alpha", "outcome", 0);
		controller.enqueue("beta", "outcome", 0);
		await tick(); // worker starts playing "alpha"

		// Fail alpha to set lastPlaybackError, then let beta start.
		playbacks[0].reject(new Error("boom"));
		await tick(); // worker processes failure, starts "beta"

		expect(controller.status().lastPlaybackError).toBe("boom");
		expect(controller.status().enabled).toBe(true);

		await controller.reset(); // stop() on beta auto-resolves

		const s = controller.status();
		expect(s.enabled).toBe(false);
		expect(s.activePlayback).toBe(false);
		expect(s.queueDepth).toBe(0);
		expect(s.lastPlaybackError).toBeNull();
	});

	test("reset with no active playback initializes state synchronously", async () => {
		const { controller } = makeController();
		controller.enable();
		controller.enqueue("one", "outcome", 0);
		// Worker microtask has not run; no active playback.
		await controller.reset();
		const s = controller.status();
		expect(s.enabled).toBe(false);
		expect(s.queueDepth).toBe(0);
		expect(s.activePlayback).toBe(false);
		expect(s.lastPlaybackError).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// 4. FIFO ordering, no overlap, immediate enqueue
// ---------------------------------------------------------------------------

describe("FIFO ordering, no overlap, immediate enqueue", () => {
	test("enqueue returns synchronously with position and depth before worker runs", () => {
		const { controller } = makeController();
		controller.enable();

		// Results are available without awaiting playback.
		const r1 = controller.enqueue("alpha", "outcome", 0);
		const r2 = controller.enqueue("beta", "outcome", 0);
		const r3 = controller.enqueue("gamma", "outcome", 0);

		expect(r1).toMatchObject({ accepted: true, position: 1, depth: 1 });
		expect(r2).toMatchObject({ accepted: true, position: 2, depth: 2 });
		expect(r3).toMatchObject({ accepted: true, position: 3, depth: 3 });
	});

	test("worker has not started before the first tick", () => {
		const { controller, playbacks } = makeController();
		controller.enable();
		controller.enqueue("first", "outcome", 0);
		// No playback exists before the worker microtask runs.
		expect(playbacks).toHaveLength(0);
	});

	test("items play in FIFO order with no overlap", async () => {
		const { controller, playbacks } = makeController();
		controller.enable();

		controller.enqueue("one", "outcome", 0);
		controller.enqueue("two", "outcome", 0);
		controller.enqueue("three", "outcome", 0);

		await tick(); // worker starts first item

		// Only the first item has started; no overlap.
		expect(playbacks).toHaveLength(1);
		expect(playbacks[0].text).toBe("one");
		expect(controller.status().activePlayback).toBe(true);
		expect(controller.status().queueDepth).toBe(2);

		playbacks[0].resolve();
		await tick(); // second item starts

		expect(playbacks).toHaveLength(2);
		expect(playbacks[1].text).toBe("two");

		playbacks[1].resolve();
		await tick(); // third item starts

		expect(playbacks).toHaveLength(3);
		expect(playbacks[2].text).toBe("three");

		playbacks[2].resolve();
		await tick(); // worker drains

		expect(controller.status().activePlayback).toBe(false);
		expect(controller.status().queueDepth).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// 5. Capacity: 3 waiting excluding active
// ---------------------------------------------------------------------------

describe("capacity 3 excluding active playback", () => {
	test("accepts 3 waiting items while one plays, then rejects the fourth", async () => {
		const { controller, playbacks } = makeController();
		controller.enable();

		controller.enqueue("one", "outcome", 0);
		await tick(); // worker starts "one"

		expect(controller.status().activePlayback).toBe(true);
		expect(controller.status().queueDepth).toBe(0);

		const r2 = controller.enqueue("two", "outcome", 0);
		const r3 = controller.enqueue("three", "outcome", 0);
		const r4 = controller.enqueue("four", "outcome", 0);

		expect(r2).toMatchObject({ accepted: true, position: 1, depth: 1 });
		expect(r3).toMatchObject({ accepted: true, position: 2, depth: 2 });
		expect(r4).toMatchObject({ accepted: true, position: 3, depth: 3 });
		expect(controller.status().queueDepth).toBe(3);

		// Fifth item: queue full.
		const r5 = controller.enqueue("five", "outcome", 0);
		expect(r5.accepted).toBe(false);
		expect(r5.message).toContain("full");
		expect(r5.position).toBeUndefined();
		expect(r5.depth).toBeUndefined();

		// Queue depth unchanged.
		expect(controller.status().queueDepth).toBe(3);

		// Clean up.
		playbacks[0].resolve();
		await tick();
		playbacks[1].resolve();
		await tick();
		playbacks[2].resolve();
		await tick();
		playbacks[3].resolve();
		await tick();
	});

	test("capacity check ignores active playback count", async () => {
		// With nothing playing, 3 items fill the waiting queue.
		const { controller } = makeController();
		controller.enable();
		expect(controller.enqueue("a", "outcome", 0).accepted).toBe(true);
		expect(controller.enqueue("b", "outcome", 0).accepted).toBe(true);
		expect(controller.enqueue("c", "outcome", 0).accepted).toBe(true);
		expect(controller.enqueue("d", "outcome", 0).accepted).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// 6. Attention priority and stale milestone supersession
// ---------------------------------------------------------------------------

describe("attention priority and milestone supersession", () => {
	test("active speech is uninterrupted while waiting attention jumps outcomes and milestones", async () => {
		const { controller, playbacks, completed } = makeController();
		controller.enable();
		controller.enqueue("active", "outcome", 0);
		await tick();

		controller.enqueue("outcome", "outcome", 1);
		controller.enqueue("milestone", "milestone", 1);
		controller.enqueue("attention", "attention", 2);
		expect(playbacks.map(playback => playback.text)).toEqual(["active"]);

		playbacks[0].resolve();
		await tick();
		playbacks[1].resolve();
		await tick();
		playbacks[2].resolve();
		await tick();
		expect(playbacks.map(playback => playback.text)).toEqual(["active", "attention", "outcome", "milestone"]);
		playbacks[3].resolve();
		await tick();
		expect(completed).toEqual([true, true, true, true]);
	});

	test("waiting attention preserves FIFO order", async () => {
		const { controller, playbacks } = makeController();
		controller.enable();
		controller.enqueue("active", "outcome", 0);
		await tick();
		controller.enqueue("outcome", "outcome", 1);
		controller.enqueue("attention-one", "attention", 2);
		controller.enqueue("attention-two", "attention", 3);

		playbacks[0].resolve();
		await tick();
		playbacks[1].resolve();
		await tick();
		expect(playbacks.map(playback => playback.text)).toEqual(["active", "attention-one", "attention-two"]);
		playbacks[2].resolve();
		await tick();
		playbacks[3].resolve();
		await tick();
	});

	test("latest milestone replaces waiting progress and frees a full queue without callbacks for removed speech", async () => {
		const { controller, playbacks, completed } = makeController();
		controller.enable();
		controller.enqueue("active", "outcome", 0);
		await tick();
		controller.enqueue("outcome-one", "outcome", 1);
		controller.enqueue("outcome-two", "outcome", 2);
		controller.enqueue("old-progress", "milestone", 3);

		const replacement = controller.enqueue("latest-progress", "milestone", 4);
		expect(replacement).toMatchObject({ accepted: true, superseded: ["old-progress"] });
		expect(controller.status().queueDepth).toBe(3);

		playbacks[0].resolve();
		await tick();
		playbacks[1].resolve();
		await tick();
		playbacks[2].resolve();
		await tick();
		expect(playbacks.map(playback => playback.text)).toEqual(["active", "outcome-one", "outcome-two", "latest-progress"]);
		playbacks[3].resolve();
		await tick();
		expect(completed).toEqual([true, true, true, true]);
	});

	for (const task of [1, 2]) test(`outcome consumes only task-one progress with waiting task ${task}`, async () => {
		const { controller, playbacks, completed } = makeController();
		controller.enable();
		controller.enqueue("active-progress", "milestone", 1);
		await tick();
		controller.enqueue("waiting-progress", "milestone", task);
		const outcome = controller.enqueue("task-one-outcome", "outcome", 1);
		expect(outcome.superseded).toEqual(task === 1 ? ["waiting-progress"] : undefined);
		expect(playbacks.map(playback => playback.text)).toEqual(["active-progress"]);
		playbacks[0].resolve();
		await tick();
		playbacks[1].resolve();
		await tick();
		if (task === 2) {
			playbacks[2].resolve();
			await tick();
		}
		expect(playbacks.map(playback => playback.text)).toEqual(task === 1
			? ["active-progress", "task-one-outcome"]
			: ["active-progress", "waiting-progress", "task-one-outcome"]);
		expect(completed).toEqual(task === 1 ? [true, true] : [true, true, true]);
	});

	test("rejected invalid, disabled, and full-queue outcomes preserve waiting milestones", async () => {
		const { controller, playbacks } = makeController();
		controller.enable();
		controller.enqueue("active", "outcome", 0);
		await tick();
		controller.enqueue("progress-one", "milestone", 1);
		controller.enqueue("waiting-result", "outcome", 2);
		controller.enqueue("outcome", "outcome", 3);

		expect(controller.enqueue("\t", "outcome", 1).accepted).toBe(false);
		expect(controller.enqueue("full", "outcome", 4).accepted).toBe(false);
		expect(controller.status().queueDepth).toBe(3);

		playbacks[0].resolve();
		await tick();
		playbacks[1].resolve();
		await tick();
		playbacks[2].resolve();
		await tick();
		expect(playbacks.map(playback => playback.text)).toEqual(["active", "progress-one", "waiting-result", "outcome"]);
		playbacks[3].resolve();
		await tick();

		const disabled = makeController();
		expect(disabled.controller.enqueue("disabled", "outcome", 1).accepted).toBe(false);
		expect(disabled.controller.status().queueDepth).toBe(0);
	});

	test("outcomes and milestones preserve FIFO order when no attention is waiting", async () => {
		const { controller, playbacks } = makeController();
		controller.enable();
		controller.enqueue("outcome-one", "outcome", 1);
		controller.enqueue("milestone", "milestone", 2);
		controller.enqueue("outcome-two", "outcome", 3);

		await tick();
		playbacks[0].resolve();
		await tick();
		playbacks[1].resolve();
		await tick();
		expect(playbacks.map(playback => playback.text)).toEqual(["outcome-one", "milestone", "outcome-two"]);
		playbacks[2].resolve();
		await tick();
	});
});

// ---------------------------------------------------------------------------
// 7. Error storage, next item continues, success clears
// ---------------------------------------------------------------------------

describe("error storage, next item, success clear", () => {
	test("playback failure is stored, reportError called, worker continues with next item", async () => {
		const { controller, playbacks, errors } = makeController();
		controller.enable();

		controller.enqueue("fail", "outcome", 0);
		controller.enqueue("succeed", "outcome", 0);

		await tick(); // worker starts "fail"

		expect(playbacks).toHaveLength(1);
		expect(controller.status().activePlayback).toBe(true);

		playbacks[0].reject(new Error("synthesis error"));
		await tick(); // worker processes failure, starts "succeed"

		expect(controller.status().lastPlaybackError).toBe("synthesis error");
		expect(errors).toHaveLength(1);
		expect(errors[0]).toContain("synthesis error");
		expect(playbacks).toHaveLength(2); // next item started
		expect(playbacks[1].text).toBe("succeed");

		// Successful playback clears the retained error.
		playbacks[1].resolve();
		await tick();

		expect(controller.status().lastPlaybackError).toBeNull();
	});

	test("startPlayback throwing is treated as playback failure", async () => {
		let shouldThrow = true;
		const errors: string[] = [];
		const playbacks: ControlledPlayback[] = [];
		const controller = new NotificationController(
			(text) => {
				if (shouldThrow) {
					shouldThrow = false;
					throw new Error("spawn failed");
				}
				const cp = makeControlledPlayback(text);
				playbacks.push(cp);
				return cp.playback;
			},
			(msg) => errors.push(msg),
		);
		controller.enable();
		controller.enqueue("first", "outcome", 0); // throws
		controller.enqueue("second", "outcome", 0); // succeeds

		await tick(); // worker processes both synchronously within one microtask run

		expect(controller.status().lastPlaybackError).toBe("spawn failed");
		expect(errors).toHaveLength(1);
		expect(playbacks).toHaveLength(1); // second item started
		expect(playbacks[0].text).toBe("second");

		// Cleanup.
		playbacks[0].resolve();
		await tick();
	});

	test("error is not cleared when toggling notifications", async () => {
		const { controller, playbacks } = makeController();
		controller.enable();
		controller.enqueue("fail", "outcome", 0);
		await tick();

		playbacks[0].reject(new Error("retained"));
		await tick();

		expect(controller.status().lastPlaybackError).toBe("retained");

		// A retained error survives toggling notifications.
		await controller.disable();
		controller.enable();
		expect(controller.status().lastPlaybackError).toBe("retained");
	});
});

// ---------------------------------------------------------------------------
// 7. Off before synthesis / off during playback: no cancellation error
// ---------------------------------------------------------------------------

describe("disable suppresses cancellation as error", () => {
	test("disable before worker runs: no playback started, no error recorded", async () => {
		const { controller, playbacks, errors } = makeController();
		controller.enable();
		controller.enqueue("hello", "outcome", 0);
		// Worker microtask still pending.
		await controller.disable();
		await tick(); // Drain the worker microtask with an empty queue.

		expect(playbacks).toHaveLength(0); // startPlayback never called
		expect(errors).toHaveLength(0);
		expect(controller.status().lastPlaybackError).toBeNull();
	});

	test("disable during active playback: stop resolves exited, no error recorded", async () => {
		const { controller, playbacks, errors } = makeController();
		controller.enable();
		controller.enqueue("playing", "outcome", 0);
		await tick(); // worker starts

		expect(playbacks).toHaveLength(1);
		expect(controller.status().activePlayback).toBe(true);

		// stop() resolves exited to simulate clean process termination.
		await controller.disable();

		expect(errors).toHaveLength(0);
		expect(controller.status().lastPlaybackError).toBeNull();
		expect(controller.status().activePlayback).toBe(false);
		expect(controller.status().enabled).toBe(false);
	});

	test("disable clears remaining waiting items along with active playback", async () => {
		const { controller, playbacks } = makeController();
		controller.enable();
		controller.enqueue("active", "outcome", 0);
		await tick(); // worker starts "active"

		controller.enqueue("queued-one", "outcome", 0);
		controller.enqueue("queued-two", "outcome", 0);
		expect(controller.status().queueDepth).toBe(2);

		await controller.disable();

		expect(controller.status().queueDepth).toBe(0);
		// Only "active" was started; the waiting items never played.
		expect(playbacks).toHaveLength(1);
	});
});

// ---------------------------------------------------------------------------
// 8. Shutdown cleanup
// ---------------------------------------------------------------------------

describe("shutdown cleanup", () => {
	test("shutdown clears queue and stops active playback", async () => {
		const { controller, playbacks, errors } = makeController();
		controller.enable();
		controller.enqueue("first", "outcome", 0);
		await tick(); // worker starts

		controller.enqueue("second", "outcome", 0);
		controller.enqueue("third", "outcome", 0);
		expect(controller.status().queueDepth).toBe(2);

		await controller.shutdown();

		expect(controller.status().queueDepth).toBe(0);
		expect(controller.status().activePlayback).toBe(false);
		expect(errors).toHaveLength(0); // explicit stop is not an error
		expect(playbacks).toHaveLength(1); // only first was started
	});

	test("shutdown with no active playback is a no-op and resolves immediately", async () => {
		const { controller } = makeController();
		controller.enable();
		controller.enqueue("waiting", "outcome", 0);
		// Worker hasn't started yet.
		await controller.shutdown();
		await tick();
		expect(controller.status().queueDepth).toBe(0);
		expect(controller.status().activePlayback).toBe(false);
	});

	test("shutdown does not record a cancellation error", async () => {
		const { controller, playbacks } = makeController();
		controller.enable();
		controller.enqueue("hello", "outcome", 0);
		await tick();

		await controller.shutdown();

		expect(controller.status().lastPlaybackError).toBeNull();
		expect(playbacks).toHaveLength(1);
	});
});

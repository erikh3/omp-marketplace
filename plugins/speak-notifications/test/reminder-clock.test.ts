import { describe, expect, test } from "bun:test";

import { ReminderClock } from "../src/reminder-clock.ts";
import type { ReminderClockScheduler } from "../src/reminder-clock.ts";

interface ScheduledTimer {
	at: number;
	callback: () => void;
	cancelled: boolean;
	unref(): void;
}

class FakeScheduler implements ReminderClockScheduler {
	private currentTime = 0;
	private readonly timers: ScheduledTimer[] = [];

	now() { return this.currentTime; }

	setTimeout(callback: () => void, delayMs: number) {
		const timer = { at: this.currentTime + delayMs, callback, cancelled: false, unref() {} };
		this.timers.push(timer);
		return timer;
	}

	clearTimeout(handle: unknown) { (handle as ScheduledTimer).cancelled = true; }

	advanceBy(milliseconds: number) {
		const target = this.currentTime + milliseconds;
		while (true) {
			const next = this.timers.filter(timer => !timer.cancelled && timer.at <= target).sort((a, b) => a.at - b.at)[0];
			if (!next) break;
			next.cancelled = true;
			this.currentTime = next.at;
			next.callback();
		}
		this.currentTime = target;
	}

	fireCancelledTimers() {
		for (const timer of this.timers.filter(timer => timer.cancelled)) timer.callback();
	}
}

function makeClock() {
	const scheduler = new FakeScheduler();
	return { clock: new ReminderClock(100, scheduler), scheduler };
}

describe("silence reminder clock", () => {
	test("expires at the boundary, consumes once, and rearms without resetting elapsed silence", () => {
		const { clock, scheduler } = makeClock();
		clock.enable();
		scheduler.advanceBy(99);
		expect(clock.takeReminder()).toBeUndefined();
		scheduler.advanceBy(1);
		expect(clock.takeReminder()).toBe(100);
		expect(clock.takeReminder()).toBeUndefined();
		scheduler.advanceBy(99);
		expect(clock.takeReminder()).toBeUndefined();
		scheduler.advanceBy(1);
		expect(clock.takeReminder()).toBe(200);
	});

	test("successful finish resets silence after playback, not at enqueue or start", () => {
		const { clock, scheduler } = makeClock();
		clock.enable();
		scheduler.advanceBy(40);
		clock.playbackStarted();
		scheduler.advanceBy(800);
		expect(clock.takeReminder()).toBeUndefined();
		clock.playbackFinished(true);
		scheduler.advanceBy(99);
		expect(clock.takeReminder()).toBeUndefined();
		scheduler.advanceBy(1);
		expect(clock.takeReminder()).toBe(100);
	});

	test("failed finish preserves silence but delays another reminder", () => {
		const { clock, scheduler } = makeClock();
		clock.enable();
		scheduler.advanceBy(40);
		clock.playbackStarted();
		scheduler.advanceBy(80);
		clock.playbackFinished(false);
		scheduler.advanceBy(99);
		expect(clock.takeReminder()).toBeUndefined();
		scheduler.advanceBy(1);
		expect(clock.takeReminder()).toBe(220);
	});

	test("idle expiry coalesces until consumed", () => {
		const { clock, scheduler } = makeClock();
		clock.enable();
		scheduler.advanceBy(500);
		expect(clock.takeReminder()).toBe(500);
		expect(clock.takeReminder()).toBeUndefined();
		scheduler.advanceBy(100);
		expect(clock.takeReminder()).toBe(600);
	});

	test("repeated enable does not postpone cooldown", () => {
		const { clock, scheduler } = makeClock();
		clock.enable();
		scheduler.advanceBy(50);
		clock.enable();
		scheduler.advanceBy(50);
		expect(clock.takeReminder()).toBe(100);
	});

	test("off resets, freezes, and rejects stale timers and playback callbacks", () => {
		const { clock, scheduler } = makeClock();
		clock.enable();
		scheduler.advanceBy(50);
		clock.disable();
		scheduler.fireCancelledTimers();
		clock.playbackFinished(true);
		scheduler.advanceBy(500);
		expect(clock.takeReminder()).toBeUndefined();
		clock.enable();
		scheduler.advanceBy(99);
		expect(clock.takeReminder()).toBeUndefined();
		scheduler.advanceBy(1);
		expect(clock.takeReminder()).toBe(100);
	});

	test("dispose cancels a pending expiry", () => {
		const { clock, scheduler } = makeClock();
		clock.enable();
		scheduler.advanceBy(100);
		clock.dispose();
		scheduler.advanceBy(500);
		expect(clock.takeReminder()).toBeUndefined();
	});
});

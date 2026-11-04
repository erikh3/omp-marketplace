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

describe("active-work reminder clock", () => {
	test("counts only active work across idle time", () => {
		const { clock, scheduler } = makeClock();
		clock.enable();
		clock.setWorking(true);
		scheduler.advanceBy(40);
		clock.setWorking(false);
		scheduler.advanceBy(3_600_000);
		clock.setWorking(true);
		scheduler.advanceBy(59);
		expect(clock.takeReminder()).toBeUndefined();
		scheduler.advanceBy(1);
		expect(clock.takeReminder()).toBe(100);
	});

	test("does not arm while enabled idle, but accepts background work", () => {
		const { clock, scheduler } = makeClock();
		clock.enable();
		scheduler.advanceBy(1_000);
		expect(clock.takeReminder()).toBeUndefined();
		clock.setWorking(true);
		scheduler.advanceBy(100);
		expect(clock.takeReminder()).toBe(100);
	});

	test("user wait preserves remaining time rather than resetting the interval", () => {
		const { clock, scheduler } = makeClock();
		clock.enable();
		clock.setWorking(true);
		scheduler.advanceBy(40);
		clock.setWaiting(true);
		scheduler.advanceBy(3_600_000);
		clock.setWaiting(false);
		scheduler.advanceBy(59);
		expect(clock.takeReminder()).toBeUndefined();
		scheduler.advanceBy(1);
		expect(clock.takeReminder()).toBe(100);
	});

	test("overlapping wait and speech pause the countdown until active work resumes", () => {
		const { clock, scheduler } = makeClock();
		clock.enable();
		clock.setWorking(true);
		scheduler.advanceBy(40);
		clock.setWaiting(true);
		scheduler.advanceBy(500);
		clock.playbackStarted();
		scheduler.advanceBy(500);
		clock.setWaiting(false);
		scheduler.advanceBy(500);
		expect(clock.takeReminder()).toBeUndefined();
		clock.playbackFinished(true);
		scheduler.advanceBy(99);
		expect(clock.takeReminder()).toBeUndefined();
		scheduler.advanceBy(1);
		expect(clock.takeReminder()).toBe(100);
	});

	test("success resets while idle and failure preserves elapsed silence but defers assessment", () => {
		const { clock, scheduler } = makeClock();
		clock.enable();
		clock.setWorking(true);
		scheduler.advanceBy(40);
		clock.playbackStarted();
		scheduler.advanceBy(500);
		clock.playbackFinished(true);
		clock.setWorking(false);
		scheduler.advanceBy(500);
		clock.setWorking(true);
		scheduler.advanceBy(100);
		expect(clock.takeReminder()).toBe(100);
		clock.playbackStarted();
		scheduler.advanceBy(500);
		clock.playbackFinished(false);
		scheduler.advanceBy(99);
		expect(clock.takeReminder()).toBeUndefined();
		scheduler.advanceBy(1);
		expect(clock.takeReminder()).toBe(200);
	});

	test("coalesces a pending expiry until active work consumes it and rearms once", () => {
		const { clock, scheduler } = makeClock();
		clock.enable();
		clock.setWorking(true);
		scheduler.advanceBy(100);
		clock.setWaiting(true);
		scheduler.advanceBy(1_000);
		expect(clock.takeReminder()).toBeUndefined();
		clock.setWaiting(false);
		expect(clock.takeReminder()).toBe(100);
		expect(clock.takeReminder()).toBeUndefined();
		scheduler.advanceBy(99);
		expect(clock.takeReminder()).toBeUndefined();
		scheduler.advanceBy(1);
		expect(clock.takeReminder()).toBe(200);
	});

	test("pending reminders count continued work but exclude subsequent idle time", () => {
		const { clock, scheduler } = makeClock();
		clock.enable();
		clock.setWorking(true);
		scheduler.advanceBy(400);
		expect(clock.takeReminder()).toBe(400);
		scheduler.advanceBy(150);
		clock.setWorking(false);
		scheduler.advanceBy(1_000);
		clock.setWorking(true);
		scheduler.advanceBy(50);
		expect(clock.takeReminder()).toBe(600);
	});

	test("handles duplicate playback starts and resets safely across disable and stale timers", () => {
		const { clock, scheduler } = makeClock();
		clock.enable();
		clock.setWorking(true);
		scheduler.advanceBy(40);
		clock.playbackStarted();
		clock.playbackStarted();
		clock.disable();
		scheduler.fireCancelledTimers();
		clock.playbackFinished(true);
		clock.setWorking(false);
		clock.enable();
		scheduler.advanceBy(500);
		expect(clock.takeReminder()).toBeUndefined();
		clock.setWorking(true);
		scheduler.advanceBy(99);
		expect(clock.takeReminder()).toBeUndefined();
		scheduler.advanceBy(1);
		expect(clock.takeReminder()).toBe(100);
	});

	test("dispose cancels pending expiry callbacks", () => {
		const { clock, scheduler } = makeClock();
		clock.enable();
		clock.setWorking(true);
		scheduler.advanceBy(50);
		clock.dispose();
		scheduler.fireCancelledTimers();
		scheduler.advanceBy(500);
		expect(clock.takeReminder()).toBeUndefined();
	});
});

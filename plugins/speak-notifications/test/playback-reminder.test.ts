import { describe, expect, test } from "bun:test";

import { NotificationController } from "../src/controller.ts";

describe("playback reminder lifecycle", () => {
	test("a queued call is not a completion; success, failure and cancellation are distinct", async () => {
		const completed: boolean[] = [];
		let pending = Promise.withResolvers<void>();
		const controller = new NotificationController(() => ({
			exited: pending.promise,
			async stop() { pending.resolve(); },
		}), () => {}, success => completed.push(success));
		controller.enable();
		try {
			controller.enqueue("One", "outcome", 0);
			await Promise.resolve();
			expect(completed).toEqual([]);
			pending.resolve();
			await Promise.resolve();
			expect(completed).toEqual([true]);

			pending = Promise.withResolvers<void>();
			controller.enqueue("Two", "outcome", 0);
			await Promise.resolve();
			pending.reject(new Error("Synthesis failed"));
			await Promise.resolve();
			expect(completed).toEqual([true, false]);

			pending = Promise.withResolvers<void>();
			controller.enqueue("Three", "outcome", 0);
			await Promise.resolve();
			await controller.disable();
			expect(completed).toEqual([true, false, false]);
		} finally { await controller.shutdown(); }
	});
});

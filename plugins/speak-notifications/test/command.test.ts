import { describe, expect, test } from "bun:test";
import type { ExtensionAPI, ExtensionCommandContext, RegisteredCommand } from "@oh-my-pi/pi-coding-agent";
import * as zod from "@oh-my-pi/omptype/zod";

import speakNotifications from "../src/index.ts";

function commandHarness() {
	let command: Omit<RegisteredCommand, "name">;
	const messages: { customType: string; content: string; details?: { enabled: boolean } }[] = [];
	const warnings: string[] = [];
	// Only the command runs here; session setup and playback belong to runtime verification.
	const pi = {
		zod,
		on() {},
		registerMessageRenderer() {},
		registerCommand(_name: string, options: Omit<RegisteredCommand, "name">) { command = options; },
		sendMessage(message: typeof messages[number]) { messages.push(message); }
	} as unknown as ExtensionAPI;
	const ctx = {
		agent: { kind: "main" },
		getAsyncJobSnapshot: () => null,
		ui: { notify(message: string) { warnings.push(message); } }
	} as unknown as ExtensionCommandContext;
	speakNotifications(pi);
	return { command: command!, ctx, messages, warnings };
}

describe("speak command", () => {
	test("bare command shows status when enabling and only a notice when disabling", async () => {
		const { command, ctx, messages } = commandHarness();
		await command.handler("", ctx);
		expect(messages[0]?.details?.enabled).toBe(true);
		expect(messages[1]?.customType).toBe("speak-notifications-status");
		expect(messages[1]?.content).toContain("Speech notifications: on\nPlayback: idle\nWaiting: 0/3");

		await command.handler("", ctx);
		expect(messages[2]?.details?.enabled).toBe(false);
		expect(messages).toHaveLength(3);
	});

	test("explicit on and off are idempotent and status does not toggle", async () => {
		const { command, ctx, messages } = commandHarness();
		for (const args of ["on", "on", "status", "status", "off", "off", "status"]) {
			await command.handler(args, ctx);
		}
		expect(messages.filter(message => message.details).map(message => message.details?.enabled))
			.toEqual([true, true, false, false]);
		const statuses = messages.filter(message => message.customType === "speak-notifications-status");
		expect(statuses[0]?.content).toContain("Speech notifications: on");
		expect(statuses[1]?.content).toContain("Speech notifications: on");
		expect(statuses[2]?.content).toContain("Speech notifications: off");
	});

	test("invalid arguments warn without toggling", async () => {
		const { command, ctx, messages, warnings } = commandHarness();
		await command.handler("on", ctx);
		for (const args of ["unknown", "on off", "ON"]) await command.handler(args, ctx);
		await command.handler("status", ctx);
		expect(warnings).toHaveLength(3);
		expect(messages.filter(message => message.details).map(message => message.details?.enabled)).toEqual([true]);
		expect(messages.at(-1)?.content).toContain("Speech notifications: on");
	});

	test("completion preserves bare toggle and only matches the single subcommand prefix", () => {
		const { command } = commandHarness();
		const complete = command.getArgumentCompletions!;
		expect(complete("")).toBeNull();
		expect(complete("o")?.map(item => item.value)).toEqual(["on", "off"]);
		expect(complete("of")?.map(item => item.value)).toEqual(["off"]);
		expect(complete("s")?.map(item => item.value)).toEqual(["status"]);
		expect(complete("unknown")).toBeNull();
		expect(complete("on ")).toBeNull();
	});
});

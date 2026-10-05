import { describe, expect, test } from "bun:test";

import { remoteShellRule } from "../../src/rules/remote-shell.ts";

function start(toolName: string, args: unknown) {
	return { toolCallId: "call-1", toolName, args };
}

describe("remoteShellRule blocking subcommands", () => {
	test("blocks on send-text, which waits for the human to press Enter", () => {
		const rule = remoteShellRule();
		expect(rule.onToolStart(start("bash", { command: "remote-shell send-text --intent 'check host' --impact inspect -- 'hostname'" }))).toBe(
			"remote shell",
		);
	});

	test("blocks on wait-output, which blocks until the human submits and the command completes", () => {
		const rule = remoteShellRule();
		expect(rule.onToolStart(start("bash", { command: "remote-shell wait-output --timeout 300000" }))).toBe("remote shell");
	});

	test("blocks on env-prefixed and command-prefixed invocations", () => {
		const rule = remoteShellRule();
		expect(rule.onToolStart(start("bash", { command: "env PAGER=cat remote-shell send-text --impact inspect -- 'ls'" }))).toBe("remote shell");
		expect(rule.onToolStart(start("bash", { command: "command remote-shell wait-output" }))).toBe("remote shell");
	});
});

describe("remoteShellRule non-blocking subcommands", () => {
	test("ignores subcommands that return promptly and never wait on the user", () => {
		const rule = remoteShellRule();
		expect(rule.onToolStart(start("bash", { command: "remote-shell layout" }))).toBeUndefined();
		expect(rule.onToolStart(start("bash", { command: "remote-shell select candidate-1" }))).toBeUndefined();
		expect(rule.onToolStart(start("bash", { command: "remote-shell read --lines 50" }))).toBeUndefined();
		expect(rule.onToolStart(start("bash", { command: "remote-shell reset" }))).toBeUndefined();
		expect(rule.onToolStart(start("bash", { command: "remote-shell dismiss-pager" }))).toBeUndefined();
	});

	test("does not match a command that merely mentions remote-shell or a non-bash tool", () => {
		const rule = remoteShellRule();
		expect(rule.onToolStart(start("bash", { command: "echo remote-shell send-text" }))).toBeUndefined();
		expect(rule.onToolStart(start("bash", { command: "which remote-shell" }))).toBeUndefined();
		expect(rule.onToolStart(start("hub", { command: "remote-shell send-text -- 'x'" }))).toBeUndefined();
		expect(rule.onToolStart(start("bash", null))).toBeUndefined();
	});
});

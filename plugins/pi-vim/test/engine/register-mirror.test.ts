/**
 * test/engine/register-mirror.test.ts
 *
 * Contract for RegisterFile's system-clipboard mirror, driven through a fake
 * ClipboardPort so the policy is deterministic and offline. Mirrors upstream's
 * "register and clipboard policy":
 *   - "all"   : every unnamed write mirrors to the clipboard.
 *   - "yank"  : only yanks mirror; deletes stay shadow-local.
 *   - "never" : nothing mirrors; the shadow is authoritative.
 *   - put reads the OS clipboard first when the last local write was mirrored,
 *     falling back to the internal shadow otherwise.
 */

import { describe, expect, test } from "bun:test";
import { RegisterFile, type ClipboardPort } from "../../src/engine/registers.ts";

/** In-memory ClipboardPort: records writes, serves a scripted peek value. */
function fakePort(): ClipboardPort & { writes: string[]; osValue: string | null } {
	const state = {
		writes: [] as string[],
		osValue: null as string | null,
		write(text: string) {
			state.writes.push(text);
			state.osValue = text; // simulate a synchronous successful mirror
		},
		peek(): string | null {
			return state.osValue;
		},
	};
	return state;
}

describe("clipboardMirror = 'all'", () => {
	test("a delete write mirrors to the clipboard", () => {
		const port = fakePort();
		const rf = new RegisterFile(port, "all");
		rf.set({ text: "gone", linewise: false }, "delete");
		expect(port.writes).toEqual(["gone"]);
	});

	test("a yank write mirrors to the clipboard", () => {
		const port = fakePort();
		const rf = new RegisterFile(port, "all");
		rf.set({ text: "copied", linewise: false }, "yank");
		expect(port.writes).toEqual(["copied"]);
	});
});

describe("clipboardMirror = 'yank'", () => {
	test("yank mirrors, delete does not", () => {
		const port = fakePort();
		const rf = new RegisterFile(port, "yank");
		rf.set({ text: "y", linewise: false }, "yank");
		rf.set({ text: "d", linewise: false }, "delete");
		expect(port.writes).toEqual(["y"]);
	});
});

describe("clipboardMirror = 'never'", () => {
	test("no write is mirrored", () => {
		const port = fakePort();
		const rf = new RegisterFile(port, "never");
		rf.set({ text: "y", linewise: false }, "yank");
		rf.set({ text: "d", linewise: false }, "delete");
		expect(port.writes).toEqual([]);
	});

	test("shadow still serves get()", () => {
		const port = fakePort();
		const rf = new RegisterFile(port, "never");
		rf.set({ text: "shadow", linewise: false }, "yank");
		expect(rf.get()?.text).toBe("shadow");
	});
});

describe("get() read-on-put", () => {
	test("prefers the OS clipboard when the last write was mirrored", () => {
		const port = fakePort();
		const rf = new RegisterFile(port, "all");
		rf.set({ text: "internal", linewise: false }, "yank"); // mirrors → osValue="internal"
		port.osValue = "external-change"; // user copied elsewhere
		expect(rf.get()?.text).toBe("external-change");
	});

	test("falls back to the shadow when the last write was policy-skipped", () => {
		const port = fakePort();
		const rf = new RegisterFile(port, "yank");
		rf.set({ text: "deleted", linewise: false }, "delete"); // skipped by policy
		port.osValue = "stale-os"; // OS clipboard must NOT be trusted here
		expect(rf.get()?.text).toBe("deleted");
	});

	test("linewise flag inferred from a trailing newline on an OS read", () => {
		const port = fakePort();
		const rf = new RegisterFile(port, "all");
		rf.set({ text: "line\n", linewise: true }, "yank");
		port.osValue = "line\n";
		const reg = rf.get();
		expect(reg?.linewise).toBe(true);
	});

	test("with no port, get() returns the shadow", () => {
		const rf = new RegisterFile(null, "all");
		rf.set({ text: "s", linewise: false }, "yank");
		expect(rf.get()?.text).toBe("s");
	});
});

describe("default construction (no port) preserves prior behaviour", () => {
	test("set then get round-trips the unnamed register", () => {
		const rf = new RegisterFile();
		rf.set({ text: "x", linewise: false });
		expect(rf.get()).toEqual({ text: "x", linewise: false });
	});

	test("clear empties the register", () => {
		const rf = new RegisterFile();
		rf.set({ text: "x", linewise: false });
		rf.clear();
		expect(rf.get()).toBeNull();
	});
});

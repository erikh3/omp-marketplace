import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { watch as fsWatch } from "node:fs";
import { chmod, mkdtemp, readFile, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startLocalPlayback, type LocalPlaybackOptions } from "../src/playback.ts";

const FIXTURES = join(import.meta.dir, "fixtures");

const BASE_OPTIONS: LocalPlaybackOptions = {
	model: "kokoro-en-us",
	voice: "af_sky",
	speed: 1.0,
	cwd: "/tmp",
};

// Isolated temp dir created per test that needs it; cleaned in afterAll as a
// belt-and-suspenders guard (each test also cleans up in its own finally).
const tmpDirs: string[] = [];

beforeAll(async () => {
	// Ensure fixture scripts are executable (write tool sets +x but belt-and-suspenders).
	for (const name of ["fail.sh", "hang.sh", "fork.sh"]) {
		await chmod(join(FIXTURES, name), 0o755);
	}
});

afterAll(async () => {
	await Promise.allSettled(tmpDirs.map((d) => rm(d, { recursive: true, force: true })));
});

describe("startLocalPlayback", () => {
	test("exited resolves when process exits 0", async () => {
		const pb = startLocalPlayback("hello", BASE_OPTIONS, "/usr/bin/true");
		await expect(pb.exited).resolves.toBeUndefined();
	});

	test("exited rejects with captured stderr on nonzero exit", async () => {
		const pb = startLocalPlayback("hello", BASE_OPTIONS, join(FIXTURES, "fail.sh"));
		await expect(pb.exited).rejects.toThrow("synthesis error: device not found");
	});

	test("exited rejects with code summary when stderr is empty", async () => {
		const pb = startLocalPlayback("hello", BASE_OPTIONS, "/usr/bin/false");
		await expect(pb.exited).rejects.toThrow(/code 1/);
	});

	test("exited rejects when binary is not found", async () => {
		const pb = startLocalPlayback("hello", BASE_OPTIONS, "/nonexistent/omp-fixture-binary");
		await expect(pb.exited).rejects.toThrow();
	});

	test("stop() resolves and exited resolves without error for running process", async () => {
		const pb = startLocalPlayback("hello", BASE_OPTIONS, join(FIXTURES, "hang.sh"));
		try {
			await pb.stop();
			await expect(pb.exited).resolves.toBeUndefined();
		} finally {
			await pb.stop().catch(() => {});
		}
	});

	test("stop() called immediately cancels before playback begins", async () => {
		const pb = startLocalPlayback("hello", BASE_OPTIONS, join(FIXTURES, "hang.sh"));
		try {
			// stop() sets stopped=true synchronously before its first await, so
			// the close handler always sees it even when the process exits immediately.
			const stopSettled = pb.stop();
			await expect(pb.exited).resolves.toBeUndefined();
			await stopSettled;
		} finally {
			await pb.stop().catch(() => {});
		}
	});

	test("stop() after natural exit is idempotent and does not kill reused PID", async () => {
		const pb = startLocalPlayback("hello", BASE_OPTIONS, "/usr/bin/true");
		await pb.exited;
		// completed=true; stop() skips kill entirely -- safe if PID was reused.
		await expect(pb.stop()).resolves.toBeUndefined();
	});

	test("stop() kills entire process group including forked child", async () => {
		const tmpDir = await mkdtemp(join(tmpdir(), "omp-speak-test-"));
		tmpDirs.push(tmpDir);
		const pidFile = join(tmpDir, "fork-child.pid");

		// Set up fs.watch before spawning so we never miss the rename event.
		// (Event-driven: fake timers cannot advance real subprocess execution.)
		const { promise: childPidReady, resolve: resolveChildPid, reject: rejectChildPid } =
			Promise.withResolvers<number>();

		const watcher = fsWatch(tmpDir, { persistent: false });
		const tryRead = () => {
			readFile(pidFile, "utf8").then((text) => {
				const n = Number(text.trim());
				if (n > 0) { watcher.close(); resolveChildPid(n); }
			}, () => { /* file not written yet; wait for next fs event */ });
		};
		// fs.watch emits one 'change' event; (eventType, filename) are the arguments.
		watcher.on("change", (_eventType, name) => {
			if (name === "fork-child.pid") tryRead();
		});
		watcher.on("error", rejectChildPid);

		// fork.sh runs with cwd=tmpDir and writes ./fork-child.pid there.
		const opts: LocalPlaybackOptions = { ...BASE_OPTIONS, cwd: tmpDir };
		const pb = startLocalPlayback("hello", opts, join(FIXTURES, "fork.sh"));

		// Immediate check covers the (unlikely) case fork.sh wrote before our first event.
		tryRead();

		try {
			const childPid = await childPidReady;

			// Verify child is alive before stopping.
			let aliveBeforeStop = false;
			try { process.kill(childPid, 0); aliveBeforeStop = true; } catch { /* gone */ }
			expect(aliveBeforeStop).toBe(true);

			await pb.stop();

			// Background sleep inherits the shell's PGID (non-interactive sh does not
			// create new process groups for background jobs), so SIGTERM to -pgid kills it.
			let aliveAfterStop = false;
			try { process.kill(childPid, 0); aliveAfterStop = true; } catch { /* gone */ }
			expect(aliveAfterStop).toBe(false);
		} finally {
			await pb.stop().catch(() => {});
			watcher.close();
			await unlink(pidFile).catch(() => {});
			await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
		}
	});
});

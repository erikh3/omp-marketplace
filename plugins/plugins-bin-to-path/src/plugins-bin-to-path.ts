import { type ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { isToolCallEventType } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import type { BashResult } from "@oh-my-pi/pi-coding-agent/exec/bash-executor";
import { getShellConfig } from "@oh-my-pi/pi-utils/procmgr";
import { delimiter, join } from "node:path";
import { getPluginsDir } from "@oh-my-pi/pi-utils/dirs";
import { existsSync, readFileSync } from "node:fs";

/** One entry in a Claude Code v2 `installed_plugins.json` plugin list. */
interface InstalledPluginEntry {
	installPath?: string;
	enabled?: boolean | undefined;
}

/**
 * Read and parse an `installed_plugins.json` registry, returning the plugin map
 * or `undefined` when the file is absent, unreadable, or not the expected shape.
 */
function readRegistry(
	registryPath: string,
): Record<string, InstalledPluginEntry[]> | undefined {
	let raw: string;
	try {
		raw = readFileSync(registryPath, "utf8");
	} catch {
		return undefined; // absent registry is the common case
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return undefined;
	}
	if (!parsed || typeof parsed !== "object" || !("plugins" in parsed)) {
		return undefined;
	}
	const { plugins } = parsed; // narrowed: `"plugins" in parsed` gives plugins: unknown
	if (!plugins || typeof plugins !== "object") return undefined;
	return plugins as Record<string, InstalledPluginEntry[]>;
}

/**
 * Prepend `binDirs` to a PATH string, dropping entries already present so the
 * result stays free of duplicates. Returns the original string when nothing new
 * is added (so callers can detect a no-op).
 */
function prependToPath(binDirs: string[], currentPath: string): string {
	if (binDirs.length === 0) return currentPath;
	const existing = currentPath.split(delimiter).filter(Boolean);
	const toAdd = binDirs.filter((dir) => !existing.includes(dir));
	if (toAdd.length === 0) return currentPath;
	return [...toAdd, ...existing].join(delimiter);
}

/**
 * Execute a `!` bang command through the SAME login shell omp uses for its bash
 * tool (`getShellConfig()`: shell binary + `-l -c` args + sanitized env), but
 * with `binDirs` prepended to PATH.
 *
 * Needed because the bang surface (`AgentSession.executeBash`) reuses a
 * persistent shell whose environment is captured at first spawn — BEFORE this
 * extension's `session_start` PATH mutation — so bundled executables never
 * resolve there. The `tool_call` `input.env` lever (used for the model bash
 * tool) does not reach the bang path; the only hook is `user_bash`, whose
 * result fully replaces execution. A freshly spawned child DOES inherit the
 * already-mutated live `process.env`, but we prepend explicitly so the fix
 * holds regardless of `session_start` ordering.
 *
 * Output is captured as a single stdout+stderr-merged stream to mirror the
 * combined PTY output the native bash surface renders.
 */
async function runBang(
	command: string,
	cwd: string,
	binDirs: string[],
): Promise<BashResult> {
	const { shell, args, env } = getShellConfig();
	const childEnv: Record<string, string> = {
		...env,
		PATH: prependToPath(binDirs, env["PATH"] ?? process.env["PATH"] ?? ""),
	};

	const proc = Bun.spawn([shell, ...args, command], {
		cwd,
		env: childEnv,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});

	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);

	const output = stdout + stderr;
	const totalBytes = Buffer.byteLength(output, "utf8");
	const totalLines = output.length === 0 ? 0 : output.split("\n").length;
	return {
		output,
		exitCode,
		cancelled: false,
		truncated: false,
		totalLines,
		totalBytes,
		outputLines: totalLines,
		outputBytes: totalBytes,
		workingDir: cwd,
	};
}

export default function (pi: ExtensionAPI) {
	const log = pi.logger;

	const getBinDirs = (): string[] => {
		const registries: string[] = [];
		registries.push(join(getPluginsDir(), "installed_plugins.json"));

		const binDirs: string[] = [];
		const seen = new Set<string>();
		for (const registryPath of registries) {
			const plugins = readRegistry(registryPath);
			if (!plugins) {
				log.error(`Could not read registry file at ${registryPath}`)
				continue;
			};

			for (const entries of Object.values(plugins)) {
				if (!Array.isArray(entries)) continue;
				for (const entry of entries) {
					if (entry.enabled === false) continue; // undefined/true both enabled
					const installPath = entry.installPath;
					if (typeof installPath !== "string" || !installPath) continue;
					const binDir = join(installPath, "bin");
					if (seen.has(binDir)) continue;
					seen.add(binDir);
					if (existsSync(binDir)) binDirs.push(binDir);
				}
			}
		}
		return binDirs;
	}

	// PATH omp was launched with, captured before any mutation below. This is the
	// same base the bash tool's shell-config env snapshot captured at settings
	// init, so prepending bin dirs to it reconstructs a PATH the tool honors
	// (verified: dev-tools bin present in the launch PATH => bash resolves it).
	const launchPath = process.env["PATH"] ?? "";

	// Bin dirs are fixed for the session (plugins are resolved at startup), so
	// resolve them once and reuse across every bash tool call.
	let cachedBinDirs: string[] | undefined;
	const binDirsOnce = (): string[] => {
		if (cachedBinDirs === undefined) {
			cachedBinDirs = getBinDirs();
			if (cachedBinDirs.length > 0) log.info(`Bin dirs: ${cachedBinDirs}`);
		}
		return cachedBinDirs;
	};

	// Mirror the bin dirs into this process's own PATH. This does NOT reach the
	// bash tool (see below), but covers surfaces that read `process.env` live in
	// this process — the `eval` JS/Python kernels and any child an extension spawns.
	pi.on("session_start", async () => {
		try {
			const binDirs = binDirsOnce();
			if (binDirs.length === 0) return;
			process.env["PATH"] = prependToPath(binDirs, process.env["PATH"] ?? "");
		} catch (e) {
			log.error(`${e}`);
		}
	});

	// The bash tool does NOT read `process.env` per command. It builds each
	// command's environment from `settings.getShellConfig().env`, a snapshot of
	// `process.env` taken at settings init — BEFORE extensions load — layered
	// with non-interactive hardening (see omp `bash-tool-runtime.md`). A later
	// `process.env` mutation from an extension can never reach it. The one
	// supported lever is revising the tool call's own `input.env`, which the
	// executor layers on top with precedence. So inject PATH here, per call,
	// seeded from the launch PATH (NOT the mutated `process.env`, which would
	// make the dedup below think the dirs are already present and skip the fix).
	pi.on("tool_call", async (event) => {
		if (!isToolCallEventType("bash", event)) return; // narrows to BashToolCallEvent
		const binDirs = binDirsOnce();
		if (binDirs.length === 0) return;

		const priorEnv = event.input.env;
		const basePath = priorEnv?.["PATH"] ?? launchPath;
		const newPath = prependToPath(binDirs, basePath);
		if (newPath === basePath) return; // already present, nothing to revise

		return { input: { ...event.input, env: { ...priorEnv, PATH: newPath } } };
	});

	// The `!` bang surface (`AgentSession.executeBash`) never fires `tool_call`,
	// so the injection above cannot reach it, and it reuses a persistent shell
	// whose env was captured before this extension loaded — so the bundled
	// executables are absent from its PATH. Its one extension hook is
	// `user_bash`: returning a `result` fully replaces execution. Run the command
	// ourselves through the same login shell with the bin dirs prepended.
	pi.on("user_bash", async (event) => {
		const binDirs = binDirsOnce();
		if (binDirs.length === 0) return;
		try {
			const result = await runBang(event.command, event.cwd, binDirs);
			return { result };
		} catch (e) {
			log.error(`user_bash injection failed: ${e}`);
			return; // fall back to omp's native bang execution
		}
	});
}

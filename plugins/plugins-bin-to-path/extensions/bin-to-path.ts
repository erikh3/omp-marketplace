import { type ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
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
 * Collect the `bin/` directory of every enabled Claude Code plugin from the
 * installed-plugins registry, skipping duplicates and non-existent dirs.
 */
function getBinDirs(logError: (msg: string) => void): string[] {
	const registryPath = join(getPluginsDir(), "installed_plugins.json");
	const plugins = readRegistry(registryPath);
	if (!plugins) {
		logError(`Could not read registry file at ${registryPath}`);
		return [];
	}

	const binDirs: string[] = [];
	const seen = new Set<string>();
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
	return binDirs;
}

/**
 * Top-level extension: put each enabled Claude Code plugin's `bin/` directory on
 * `PATH` so bundled executables (e.g. `bg-gradle`) run by bare name under omp.
 *
 * A top-level extension loads BEFORE omp spawns its persistent Bash shell, so a
 * single `process.env.PATH` mutation at `session_start` reaches every surface
 * that derives its environment from the live process env — the model `bash`
 * tool, user `!` bang commands, the `eval` JS/Python kernels, and any child an
 * extension spawns. No per-call `tool_call`/`user_bash` handling is needed, so
 * command lines render clean.
 *
 * (The marketplace-plugin form of this logic loads too late for that and must
 * fall back to per-call `input.env` injection — see this repo's README.)
 */
export default function (pi: ExtensionAPI) {
	const log = pi.logger;
	pi.on("session_start", async () => {
		try {
			const binDirs = getBinDirs((msg) => log.error(msg));
			if (binDirs.length === 0) return;
			log.info(`Bin dirs: ${binDirs}`);
			process.env["PATH"] = prependToPath(binDirs, process.env["PATH"] ?? "");
		} catch (e) {
			log.error(`${e}`);
		}
	});
}

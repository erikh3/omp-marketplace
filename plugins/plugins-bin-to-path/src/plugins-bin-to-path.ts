import { type ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import * as os from "node:os";
import { delimiter, join } from "node:path";


/**
 * Returns the omp plugins directory (~/.omp/plugins), respecting the
 * PI_CONFIG_DIR override and XDG_DATA_HOME (Linux) when present.
 */
function getPluginsDir(): string {
	const configDirName = Bun.env.PI_CONFIG_DIR ?? ".omp";
	// XDG_DATA_HOME is only honored on Linux per omp convention.
	if (process.platform === "linux") {
		const xdg = Bun.env.XDG_DATA_HOME;
		if (xdg && existsSync(join(xdg, "omp"))) {
			return join(xdg, "omp", "plugins");
		}
	}
	return join(os.homedir(), configDirName, "plugins");
}

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

/** Prepend `binDirs` to a PATH string without duplicate entries. */
function prependToPath(binDirs: string[], currentPath: string): string {
	if (binDirs.length === 0) return currentPath;
	const existing = currentPath.split(delimiter).filter(Boolean);
	const toAdd = binDirs.filter((dir) => !existing.includes(dir));
	if (toAdd.length === 0) return currentPath;
	return [...toAdd, ...existing].join(delimiter);
}


export default function (pi: ExtensionAPI) {
	const log = pi.logger;
	const registryPath = join(getPluginsDir(), "installed_plugins.json");
	const plugins = readRegistry(registryPath);
	if (!plugins) {
		log.error(`Could not read registry file at ${registryPath}`);
		return;
	}

	const binDirs: string[] = [];
	const seen = new Set<string>();
	for (const entries of Object.values(plugins)) {
		if (!Array.isArray(entries)) continue;
		for (const entry of entries) {
			if (entry.enabled === false) continue;
			const installPath = entry.installPath;
			if (typeof installPath !== "string" || !installPath) continue;
			const binDir = join(installPath, "bin");
			if (seen.has(binDir)) continue;
			seen.add(binDir);
			if (existsSync(binDir)) binDirs.push(binDir);
		}
	}
	if (binDirs.length === 0) return;

	// omp caches this object process-wide before extensions load. Every Bash
	// execution reads it, including restricted subagents that load no extensions.
	const shellEnv = pi.pi.settings.getShellConfig().env;
	shellEnv.PATH = prependToPath(binDirs, shellEnv.PATH ?? "");

	// Eval kernels and extension-spawned children read the live process env.
	process.env.PATH = prependToPath(binDirs, process.env.PATH ?? "");
	log.info(`Bin dirs: ${binDirs}`);
}

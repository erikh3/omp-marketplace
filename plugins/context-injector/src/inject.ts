import type { ExtensionAPI, Skill } from "@oh-my-pi/pi-coding-agent";
import { buildSkillPromptMessage, getActiveSkills } from "@oh-my-pi/pi-coding-agent";
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { homedir } from "node:os";
import type { InjectionEntry } from "./types.ts";

/** Maximum bytes read from a single file before it is skipped. */
const MAX_FILE_BYTES = 512 * 1024;

/** Valid skill name: lowercase alphanumeric and hyphens, must start and end with alphanumeric. */
const SKILL_NAME_RE = /^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/;

/**
 * Returns the skill name when the entry uses the `skill://` scheme AND the
 * name is a non-empty, valid identifier. Returns null for everything else
 * (file paths, globs, bare scheme `skill://`, whitespace-only names).
 */
export function skillNameOf(path: string): string | null {
	if (!path.startsWith("skill://")) return null;
	const name = path.slice("skill://".length).trim();
	if (!name || !SKILL_NAME_RE.test(name)) return null;
	return name;
}

const expandHome = (p: string): string =>
	p === "~" || p.startsWith("~/") ? join(homedir(), p.slice(1)) : p;

function resolveFilePaths(rawPath: string): string[] {
	const expanded = expandHome(rawPath);
	if (/[*?{[]/.test(expanded)) {
		try {
			return Array.from(
				new Bun.Glob(expanded).scanSync({ absolute: true, onlyFiles: true }),
			);
		} catch {
			return [];
		}
	}
	return existsSync(expanded) ? [resolve(expanded)] : [];
}

/**
 * Read all files matched by `rawPath` and concatenate their contents.
 * Files exceeding MAX_FILE_BYTES are skipped. Multiple glob matches are
 * separated by filename (basename only) comments.
 * Returns null when no readable files are found.
 */
export function buildFileContent(rawPath: string): string | null {
	const matches = resolveFilePaths(rawPath);
	const parts: string[] = [];

	for (const filePath of matches) {
		try {
			const size = statSync(filePath).size;
			if (size > MAX_FILE_BYTES) continue;
			const text = readFileSync(filePath, "utf8").trimEnd();
			if (!text) continue;
			parts.push(matches.length > 1 ? `<!-- ${basename(filePath)} -->\n${text}` : text);
		} catch {
			// Unreadable or stat failed — skip silently; caller logs the miss
		}
	}

	return parts.length > 0 ? parts.join("\n\n") : null;
}

/**
 * Build the injection content for a skill entry using omp's own
 * `buildSkillPromptMessage` with `"autoload"` provenance, matching the
 * format omp uses for natively autoloaded skills.
 * Returns null when the skill name is not found in the active registry.
 */
export async function buildSkillContent(
	name: string,
	logger: ExtensionAPI["logger"],
): Promise<string | null> {
	const skill = getActiveSkills().find((s: Skill) => s.name === name);

	if (!skill) {
		logger.warn(`context-injector: skill '${name}' not found in active registry`, {
			available: getActiveSkills().map((s: Skill) => s.name),
		});
		return null;
	}

	logger.debug(`context-injector: building skill content for '${name}'`, {
		filePath: skill.filePath,
	});

	try {
		const result = await buildSkillPromptMessage(skill, "", "autoload");
		// Guard against future API shape changes
		if (!result?.message || typeof result.message !== "string") {
			logger.warn(`context-injector: unexpected response shape from buildSkillPromptMessage for '${name}'`);
			return null;
		}
		return result.message;
	} catch (err) {
		logger.warn(`context-injector: failed to render skill '${name}'`, { err });
		return null;
	}
}

/**
 * Resolve and render one injection entry to a content string.
 * Returns null when nothing could be loaded (missing skill, unreadable files).
 */
export async function buildSection(
	entry: InjectionEntry,
	logger: ExtensionAPI["logger"],
): Promise<string | null> {
	const skillName = skillNameOf(entry.path);

	let content: string | null;
	try {
		content = skillName !== null
			? await buildSkillContent(skillName, logger)
			: buildFileContent(entry.path);
	} catch (err) {
		logger.warn(`context-injector: unexpected error resolving entry`, { path: entry.path, err });
		return null;
	}

	if (!content) {
		logger.debug(`context-injector: no content for entry`, { path: entry.path });
		return null;
	}

	const label = entry.label ?? entry.path;

	// Skill entries without a custom label use their own template structure
	// (body + "Skill: <path>" footer) — no wrapper header needed.
	return skillName !== null && !entry.label
		? content
		: `## ${label}\n\n${content}`;
}

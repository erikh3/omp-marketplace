import type { ExtensionAPI, Skill, SkillInvocationKind } from "@oh-my-pi/pi-coding-agent";
import { buildSkillPromptMessage, getActiveSkills } from "@oh-my-pi/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import type { InjectionEntry } from "./types.ts";

/** Returns the skill name when the entry uses the `skill://` scheme, else null. */
export const skillNameOf = (path: string): string | null =>
	path.startsWith("skill://") ? path.slice("skill://".length).trim() : null;

const expandHome = (p: string): string =>
	p === "~" || p.startsWith("~/") ? join(homedir(), p.slice(1)) : p;

function resolveFilePaths(rawPath: string): string[] {
	const expanded = expandHome(rawPath);
	if (/[*?{[]/.test(expanded)) {
		return Array.from(
			new Bun.Glob(expanded).scanSync({ absolute: true, onlyFiles: true }),
		);
	}
	return existsSync(expanded) ? [resolve(expanded)] : [];
}

/**
 * Read all files matched by `rawPath` and concatenate their contents.
 * Multiple glob matches are separated by filename comments so the model
 * can attribute content to individual files.
 * Returns null when no readable files are found.
 */
export function buildFileContent(rawPath: string): string | null {
	const matches = resolveFilePaths(rawPath);
	const parts: string[] = [];

	for (const filePath of matches) {
		try {
			const text = readFileSync(filePath, "utf8").trimEnd();
			if (!text) continue;
			parts.push(matches.length > 1 ? `<!-- ${filePath} -->\n${text}` : text);
		} catch {
			// Unreadable — skip silently; caller logs the miss
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
		const { message } = await buildSkillPromptMessage(
			skill,
			"",
			"autoload" as SkillInvocationKind,
		);
		return message;
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

	const content = skillName !== null
		? await buildSkillContent(skillName, logger)
		: buildFileContent(entry.path);

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

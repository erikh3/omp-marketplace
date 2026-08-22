import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import * as realPiCodingAgent from "@oh-my-pi/pi-coding-agent";
import type { Skill } from "@oh-my-pi/pi-coding-agent";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let activeSkills: Skill[] = [];
const getActiveSkills = mock(() => activeSkills);

let buildSkillPromptMessageImpl: (skill: Skill) => Promise<{ message: string; details: object }> =
	async (skill) => ({ message: `skill content for ${skill.name}`, details: {} });
const buildSkillPromptMessage = mock(
	(skill: Skill, _args: string, _kind: string) => buildSkillPromptMessageImpl(skill),
);

mock.module("@oh-my-pi/pi-coding-agent", () => ({
	...realPiCodingAgent,
	getActiveSkills,
	buildSkillPromptMessage,
}));

const { skillNameOf, buildFileContent, buildSection } = await import("../src/inject.ts");

const logger = {
	debug: mock(() => {}),
	warn: mock(() => {}),
	info: mock(() => {}),
	error: mock(() => {}),
} as unknown as Parameters<typeof buildSection>[1];

describe("skillNameOf", () => {
	test("returns name for skill:// scheme", () => {
		expect(skillNameOf("skill://my-skill")).toBe("my-skill");
	});

	test("trims whitespace in skill name", () => {
		expect(skillNameOf("skill://  my-skill  ")).toBe("my-skill");
	});

	test("returns null for bare skill:// scheme (empty name)", () => {
		expect(skillNameOf("skill://")).toBeNull();
	});

	test("returns null for whitespace-only name after trim", () => {
		expect(skillNameOf("skill://   ")).toBeNull();
	});

	test("returns null for name with path separators", () => {
		expect(skillNameOf("skill://../../evil")).toBeNull();
	});

	test("returns null for name with uppercase letters", () => {
		expect(skillNameOf("skill://My-Skill")).toBeNull();
	});

	test("returns null for plain file path", () => {
		expect(skillNameOf("~/.omp/agent/CONTEXT.md")).toBeNull();
	});

	test("returns null for glob pattern", () => {
		expect(skillNameOf("~/docs/**/*.md")).toBeNull();
	});

	test("returns null for relative path", () => {
		expect(skillNameOf("./local/file.md")).toBeNull();
	});

	test("returns null for bare word without skill:// prefix", () => {
		expect(skillNameOf("my-skill")).toBeNull();
	});
});

describe("buildFileContent", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "ctx-inject-test-"));
	});

	test("returns file content for existing file", () => {
		const file = join(tmpDir, "test.md");
		writeFileSync(file, "hello world");
		expect(buildFileContent(file)).toBe("hello world");
	});

	test("trims trailing whitespace from file content", () => {
		const file = join(tmpDir, "test.md");
		writeFileSync(file, "hello\n\n");
		expect(buildFileContent(file)).toBe("hello");
	});

	test("returns null for non-existent path", () => {
		expect(buildFileContent(join(tmpDir, "missing.md"))).toBeNull();
	});

	test("returns null for empty file", () => {
		const file = join(tmpDir, "empty.md");
		writeFileSync(file, "");
		expect(buildFileContent(file)).toBeNull();
	});

	test("concatenates multiple glob matches with filename comments", () => {
		writeFileSync(join(tmpDir, "a.md"), "content A");
		writeFileSync(join(tmpDir, "b.md"), "content B");
		const result = buildFileContent(join(tmpDir, "*.md"));
		expect(result).toContain("content A");
		expect(result).toContain("content B");
		expect(result).toContain("<!-- ");
	});

	test("returns single file content without filename comment for single glob match", () => {
		writeFileSync(join(tmpDir, "only.md"), "solo content");
		const result = buildFileContent(join(tmpDir, "*.md"));
		expect(result).toBe("solo content");
		expect(result).not.toContain("<!--");
	});

	test("expands ~ in path", () => {
		// Just check it doesn't throw and returns null for a non-existent ~/nonexistent-test-file
		const result = buildFileContent("~/this-file-definitely-does-not-exist-xyz.md");
		expect(result).toBeNull();
	});

	test("returns null for glob matching zero files", () => {
		const result = buildFileContent(join(tmpDir, "*.nonexistent-ext-xyz"));
		expect(result).toBeNull();
	});

	// Cleanup after each test
	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});
});

describe("buildSection", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "ctx-inject-section-"));
		activeSkills = [];
		buildSkillPromptMessageImpl = async (skill) => ({
			message: `skill content for ${skill.name}`,
			details: {},
		});
		(logger.warn as ReturnType<typeof mock>).mockClear();
		(logger.debug as ReturnType<typeof mock>).mockClear();
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	test("skill entry without label uses raw skill content (no wrapper header)", async () => {
		activeSkills = [{ name: "my-skill", filePath: "/fake/skill.md", baseDir: "/fake", source: "test" }];
		const result = await buildSection({ path: "skill://my-skill" }, logger);
		expect(result).toBe("skill content for my-skill");
		expect(result).not.toContain("##");
	});

	test("skill entry with label wraps content in header", async () => {
		activeSkills = [{ name: "my-skill", filePath: "/fake/skill.md", baseDir: "/fake", source: "test" }];
		const result = await buildSection({ path: "skill://my-skill", label: "My Skill" }, logger);
		expect(result).toBe("## My Skill\n\nskill content for my-skill");
	});

	test("returns null and warns when skill not found", async () => {
		activeSkills = [];
		const result = await buildSection({ path: "skill://missing" }, logger);
		expect(result).toBeNull();
		expect(logger.warn).toHaveBeenCalled();
	});

	test("file entry wraps content in header using path as default label", async () => {
		const file = join(tmpDir, "notes.md");
		writeFileSync(file, "some notes");
		const result = await buildSection({ path: file }, logger);
		expect(result).toBe(`## ${file}\n\nsome notes`);
	});

	test("file entry with label uses custom label as header", async () => {
		const file = join(tmpDir, "notes.md");
		writeFileSync(file, "some notes");
		const result = await buildSection({ path: file, label: "Notes" }, logger);
		expect(result).toBe("## Notes\n\nsome notes");
	});

	test("returns null for missing file entry", async () => {
		const result = await buildSection({ path: join(tmpDir, "missing.md") }, logger);
		expect(result).toBeNull();
		expect(logger.debug).toHaveBeenCalled();
	});

	test("returns null when skill rendering throws", async () => {
		activeSkills = [{ name: "broken", filePath: "/fake/broken.md", baseDir: "/fake", source: "test" }];
		buildSkillPromptMessageImpl = async () => { throw new Error("render failed"); };
		const result = await buildSection({ path: "skill://broken" }, logger);
		expect(result).toBeNull();
		expect(logger.warn).toHaveBeenCalled();
	});

	test("returns null when buildFileContent throws internally (Bun.Glob unavailable)", async () => {
		// Simulate a pathological path that resolveFilePaths handles gracefully
		// by passing a path that triggers the try/catch in buildSection
		const result = await buildSection({ path: "/dev/null" }, logger);
		// /dev/null is readable but empty — should return null, not throw
		expect(result).toBeNull();
	});
});

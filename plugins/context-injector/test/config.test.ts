import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Dynamic import justified: mock.module must run before module evaluation
// so getAgentDir is replaced before config.ts binds to it.
import * as realPiCodingAgent from "@oh-my-pi/pi-coding-agent";
import { mock } from "bun:test";

let agentDir = "/nonexistent-agent-dir";
mock.module("@oh-my-pi/pi-coding-agent", () => ({
	...realPiCodingAgent,
	getAgentDir: () => agentDir,
}));

const { loadConfig, loadMergedConfig } = await import("../src/config.ts");

// ---------------------------------------------------------------------------
// loadConfig
// ---------------------------------------------------------------------------

describe("loadConfig", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "ctx-cfg-test-"));
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	test("returns null when file does not exist", () => {
		expect(loadConfig(join(tmpDir, "missing.yml"))).toBeNull();
	});

	test("parses a minimal valid config", () => {
		const file = join(tmpDir, "context-injector.yml");
		writeFileSync(file, `inject:\n  - path: "skill://my-skill"\n`);
		expect(loadConfig(file)).toEqual({
			inject: [{ path: "skill://my-skill" }],
		});
	});

	test("parses all optional fields", () => {
		const file = join(tmpDir, "context-injector.yml");
		writeFileSync(file, [
			"inject:",
			'  - path: "skill://my-skill"',
			'    label: "My Skill"',
			"    once: false",
			"    display: true",
		].join("\n"));
		expect(loadConfig(file)).toEqual({
			inject: [{ path: "skill://my-skill", label: "My Skill", once: false, display: true }],
		});
	});

	test("parses multiple entries", () => {
		const file = join(tmpDir, "context-injector.yml");
		writeFileSync(file, [
			"inject:",
			'  - path: "skill://a"',
			'  - path: "~/docs/b.md"',
			'    label: "B"',
		].join("\n"));
		const result = loadConfig(file);
		expect(result?.inject).toHaveLength(2);
		expect(result?.inject[0]?.path).toBe("skill://a");
		expect(result?.inject[1]?.path).toBe("~/docs/b.md");
		expect(result?.inject[1]?.label).toBe("B");
	});

	test("throws when inject list is missing", () => {
		const file = join(tmpDir, "context-injector.yml");
		writeFileSync(file, "someOtherKey: value\n");
		expect(() => loadConfig(file)).toThrow();
	});

	test("throws when an entry has no path", () => {
		const file = join(tmpDir, "context-injector.yml");
		writeFileSync(file, "inject:\n  - label: orphan\n");
		expect(() => loadConfig(file)).toThrow();
	});

	test("throws when root is not a mapping", () => {
		const file = join(tmpDir, "context-injector.yml");
		writeFileSync(file, "- just a list\n");
		expect(() => loadConfig(file)).toThrow();
	});
});

// ---------------------------------------------------------------------------
// loadMergedConfig
// ---------------------------------------------------------------------------

describe("loadMergedConfig", () => {
	let tmpDir: string;
	let projectDir: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "ctx-merged-test-"));
		projectDir = join(tmpDir, "project");
		agentDir = join(tmpDir, "agent");
		mkdirSync(join(projectDir, ".omp"), { recursive: true });
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	test("returns empty inject list when neither config exists", () => {
		expect(loadMergedConfig(projectDir)).toEqual({ inject: [] });
	});

	test("returns user config when only user config exists", () => {
		writeFileSync(
			join(agentDir, "context-injector.yml"),
			'inject:\n  - path: "skill://user-skill"\n',
		);
		expect(loadMergedConfig(projectDir)).toEqual({
			inject: [{ path: "skill://user-skill" }],
		});
	});

	test("returns project config when only project config exists", () => {
		writeFileSync(
			join(projectDir, ".omp", "context-injector.yml"),
			'inject:\n  - path: "skill://project-skill"\n',
		);
		expect(loadMergedConfig(projectDir)).toEqual({
			inject: [{ path: "skill://project-skill" }],
		});
	});

	test("project entries appear before user entries when both configs exist", () => {
		writeFileSync(
			join(projectDir, ".omp", "context-injector.yml"),
			'inject:\n  - path: "skill://project-skill"\n',
		);
		writeFileSync(
			join(agentDir, "context-injector.yml"),
			'inject:\n  - path: "skill://user-skill"\n',
		);
		const result = loadMergedConfig(projectDir);
		expect(result.inject).toHaveLength(2);
		expect(result.inject[0]?.path).toBe("skill://project-skill");
		expect(result.inject[1]?.path).toBe("skill://user-skill");
	});

	test("skips invalid user config and returns project config", () => {
		writeFileSync(
			join(projectDir, ".omp", "context-injector.yml"),
			'inject:\n  - path: "skill://project-skill"\n',
		);
		writeFileSync(
			join(agentDir, "context-injector.yml"),
			"- this is not a valid mapping\n",
		);
		const result = loadMergedConfig(projectDir);
		expect(result.inject).toHaveLength(1);
		expect(result.inject[0]?.path).toBe("skill://project-skill");
	});

	test("skips invalid project config and returns user config", () => {
		writeFileSync(
			join(projectDir, ".omp", "context-injector.yml"),
			"- this is not a valid mapping\n",
		);
		writeFileSync(
			join(agentDir, "context-injector.yml"),
			'inject:\n  - path: "skill://user-skill"\n',
		);
		const result = loadMergedConfig(projectDir);
		expect(result.inject).toHaveLength(1);
		expect(result.inject[0]?.path).toBe("skill://user-skill");
	});

	test("returns empty inject list when both configs are invalid", () => {
		writeFileSync(
			join(projectDir, ".omp", "context-injector.yml"),
			"- bad\n",
		);
		writeFileSync(
			join(agentDir, "context-injector.yml"),
			"- bad\n",
		);
		expect(loadMergedConfig(projectDir)).toEqual({ inject: [] });
	});
});

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { IncidentStore } from "../src/incident-store.ts";

const directories: string[] = [];

afterEach(async () => {
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("IncidentStore", () => {
	test("keeps an incident until its exact repository and path are resolved", async () => {
		const directory = await mkdtemp(join(tmpdir(), "worktree-manager-incidents-"));
		directories.push(directory);
		const store = new IncidentStore(join(directory, "incidents.json"));
		const incident = {
			repository: "/repos/example",
			path: "/worktrees/example",
			backend: "git",
			expected: "/repos/example/.omp/worktrees",
			createdAt: "2026-01-01T00:00:00.000Z",
		};

		await store.record(incident);
		await store.record({ ...incident, createdAt: "2026-01-02T00:00:00.000Z" });

		expect(await store.list(incident.repository)).toEqual([{ ...incident, createdAt: "2026-01-02T00:00:00.000Z" }]);
		await store.clear(incident.repository, incident.path);
		expect(await store.list()).toEqual([]);
	});
});

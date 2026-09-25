import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export interface RelocationIncident {
	repository: string;
	path: string;
	backend: string;
	expected: string;
	createdAt: string;
}

interface IncidentDocument {
	version: 1;
	incidents: RelocationIncident[];
}

function key(incident: Pick<RelocationIncident, "repository" | "path">): string {
	return `${incident.repository}\u0000${incident.path}`;
}

/** Persists direct-creation mismatches until a managed lifecycle operation resolves them. */
export class IncidentStore {
	constructor(private readonly file = join(homedir(), ".omp", "agent", "worktree-manager-incidents.json")) {}

	async list(repository?: string): Promise<RelocationIncident[]> {
		const document = await this.read();
		return repository === undefined
			? document.incidents
			: document.incidents.filter((incident) => incident.repository === repository);
	}

	async record(incident: RelocationIncident): Promise<void> {
		const document = await this.read();
		const incidents = document.incidents.filter((existing) => key(existing) !== key(incident));
		incidents.push(incident);
		await this.write({ version: 1, incidents });
	}

	async clear(repository: string, path: string): Promise<void> {
		const document = await this.read();
		const incidents = document.incidents.filter((incident) => key(incident) !== key({ repository, path }));
		if (incidents.length !== document.incidents.length) {
			await this.write({ version: 1, incidents });
		}
	}

	private async read(): Promise<IncidentDocument> {
		try {
			const parsed: unknown = JSON.parse(await readFile(this.file, "utf8"));
			if (!isIncidentDocument(parsed)) throw new Error("invalid incident document");
			return parsed;
		} catch (error) {
			if (isMissingFile(error)) return { version: 1, incidents: [] };
			throw new Error(`Cannot read worktree-manager incidents: ${errorMessage(error)}`);
		}
	}

	private async write(document: IncidentDocument): Promise<void> {
		await mkdir(dirname(this.file), { recursive: true });
		const temporary = resolve(`${this.file}.tmp`);
		await writeFile(temporary, `${JSON.stringify(document, null, "\t")}\n`, "utf8");
		await rename(temporary, this.file);
	}
}

function isIncidentDocument(value: unknown): value is IncidentDocument {
	if (!value || typeof value !== "object" || !("version" in value) || !("incidents" in value)) return false;
	return value.version === 1 && Array.isArray(value.incidents) && value.incidents.every(isIncident);
}

function isIncident(value: unknown): value is RelocationIncident {
	if (!value || typeof value !== "object") return false;
	return ["repository", "path", "backend", "expected", "createdAt"].every(
		(field) => field in value && typeof value[field as keyof typeof value] === "string",
	);
}

function isMissingFile(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

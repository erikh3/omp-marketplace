/**
 * One injection entry from context-injector.yml.
 *
 * Two path forms are accepted:
 *
 *   Skill:  "skill://work-obsidian"  — resolved via omp's active skill registry
 *   File:   "~/.omp/agent/CONTEXT.md" or "~/docs/*.md"  — filesystem path or glob
 *
 * Config-file order equals injection order: entries are injected into context
 * in the exact sequence they appear. When both project (.omp/context-injector.yml)
 * and user (~/.omp/agent/context-injector.yml) configs exist, project entries
 * come first.
 *
 * `label`   — section header in the injected message (defaults to the path value).
 *             Skill entries without a custom label omit the wrapper header since
 *             omp's skill template already provides its own structure.
 * `once`    — inject only on the first agent turn per session (default: true).
 * `display` — surface the injected message in the TUI chat history (default: false).
 */
export interface InjectionEntry {
	path: string;
	label?: string;
	once?: boolean;
	display?: boolean;
}

export interface ContextInjectorConfig {
	inject: InjectionEntry[];
}

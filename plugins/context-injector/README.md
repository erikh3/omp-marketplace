# context-injector

Inject skills and arbitrary file contents into the LLM context at agent-start time.

Useful for automatically loading skills, reference documents, style guides, or
any other file you want the agent to have in context without manually invoking
`skill://` on every turn.

## How it works

The extension listens to the `before_agent_start` event and prepends a hidden
context message containing the resolved content. By default, each entry is injected
only once per session (`once: true`), so the cost is paid once at the first turn.

Skill entries are resolved via omp's active skill registry and rendered using the
same format omp uses for native skill autoloading (`buildSkillPromptMessage`).

## Configuration

Create `~/.omp/agent/context-injector.yml` for user-level (all projects) or
`.omp/context-injector.yml` in a project root for project-level entries.
Both are merged; project entries appear first.

**Injection order** matches config order exactly: entries are injected into the
LLM context in the sequence they appear in the file. When both configs exist,
all project entries precede all user entries.

```yaml
inject:
  # Inject a skill by name — resolved from omp's active skill registry
  - path: "skill://my-skill"

  # Inject a single file by path
  - path: "~/.omp/agent/CONTEXT.md"
    label: "project context"

  # Inject every file in a directory using a glob
  - path: "~/Work/guidelines/**/*.md"
    label: "team guidelines"

  # Re-inject on every agent turn (e.g. a volatile status file)
  - path: "~/Work/current-sprint.md"
    label: "current sprint"
    once: false

  # Show in the TUI rather than hidden
  - path: "skill://my-tool"
    label: "my tool skill"
    display: true
```

### Entry fields

| Field     | Default        | Description |
|-----------|----------------|-------------|
| `path`    | required       | `skill://name`, file path, or glob. `~` is expanded. |
| `label`   | `path` value   | Section header in the injected message. Skill entries without a custom label omit the header (the skill template provides its own structure). |
| `once`    | `true`         | Inject only on the first agent turn per session. Set to `false` to re-inject every turn. |
| `display` | `false`        | Show the injected message in the TUI chat history. |

### Skill resolution

`skill://name` entries are looked up in omp's process-global active skill
registry (`getActiveSkills()`), which is populated before the first agent turn.
Skills installed via the marketplace, symlinked into `~/.omp/agent/skills/`, or
discovered in any configured skill directory are all reachable.

If a skill name is not found in the registry, a warning is logged to
`~/.omp/logs/` and the entry is silently skipped.

### Display behavior

When any entry has `display: true`, the combined context message is shown in the
TUI. All entries are merged into one message; if any have `display: true` the
whole message is visible.

## Installation

```
/marketplace install context-injector@erikh3-omp-marketplace
```

Or symlink the extension directly into `~/.omp/agent/extensions/`:

```sh
ln -s /path/to/plugins/context-injector/src/index.ts \
      ~/.omp/agent/extensions/context-injector.ts
```

After installing, create your `~/.omp/agent/context-injector.yml` and restart
omp (or `/reload`).

## Development

### Structure

```
src/
  types.ts    — InjectionEntry and ContextInjectorConfig interfaces
  config.ts   — YAML loading, validation, and user/project config merging
  inject.ts   — skill and file content builders, section renderer
  index.ts    — extension factory (session_start / before_agent_start handlers)
test/
  config.test.ts  — loadConfig and loadMergedConfig
  inject.test.ts  — skillNameOf, buildFileContent, buildSection
```

### Setup

```sh
bun install
```

### Tests

```sh
bun test
```

### Type checking

```sh
bun run typecheck
```

### Logging

The extension emits `debug`-level log entries at key points (config load, per-entry
injection decisions, final message stats). Tail today's omp log to see them:

```sh
tail -f ~/.omp/logs/omp.$(date +%F).*.log
```

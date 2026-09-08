# obsidian-welcome

Animated Obsidian-aware startup widget for omp.

The plugin activates only when the omp working directory is inside an Obsidian vault. It asks the Obsidian CLI for the active vault first and verifies that the working directory belongs to it. If the CLI is unavailable, fails, or points at another vault, it finds the nearest ancestor containing `.obsidian`. Sessions started in vault subdirectories work without project configuration.

The widget shows:

- A three-second purple gradient and shine animation over the Obsidian logo
- The detected vault name and current subdirectory when below the vault root
- The active model and provider
- Daily-note status for the last seven days
- Five most recently edited Markdown notes with their edit age
- OMP input shortcuts

Files under `Private/` never appear in recent edits. The widget disappears on first input and releases its animation timer.

## Install

```text
omp plugin install obsidian-welcome@erikh3-omp-marketplace
```

Restart omp after installation. No project-local extension or configuration is needed.

## Development

```text
bun install
bun run typecheck
omp plugin link ./plugins/obsidian-welcome
```

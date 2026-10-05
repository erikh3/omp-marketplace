# herdr-interactive-tool-block

Report the Herdr pane as **blocked** while an interactive tool waits for user input in the middle of its own execution.

## The problem

omp approves a tool at its own approval gate and then runs it. Some MCP tools, notably `browser-tools` `click`, `input_text`, and `pick`, block *inside the MCP server* after that, waiting for the user to confirm the action in Chrome. omp still sees the tool executing, so the Herdr-managed omp integration keeps the pane in the `working` state even though it is really waiting for the user.

The managed integration (`~/.omp/agent/extensions/herdr-omp-agent-state.ts`) only treats omp's own approval gate and the `ask` tool as blocking. Mid-execution MCP waits slip through.

## Behavior

- Runs only inside a Herdr-managed pane (`HERDR_ENV=1`).
- Watches the main omp session only. Subagents cannot change the pane state.
- When a configured tool starts, emits `herdr:blocked` `{ active: true, label }` on the shared `pi.events` bus. When it ends, emits `{ active: false }`.
- The Herdr-managed omp integration ref-counts those events and flips the pane to `blocked` while any block is outstanding, then back to `working`/`idle` when they clear. This plugin cooperates with that ref-count rather than reporting state to Herdr directly.
- Tracks each tool call by id, so overlapping or interleaved calls each open and close their own block.
- Clears any still-open block on session shutdown, so a crash mid-approval does not strand the pane in `blocked`.

The block label is the tool call's intent when present (for example `Clicking Le Corbusier link`), otherwise a tidied tool name.

## Configuration

| Setting | Type | Default | Description |
| --- | --- | --- | --- |
| `enabled` | boolean | `true` | Flip the pane to blocked while a matching tool waits. |
| `tools` | array | `["browser_tools_click", "browser_tools_input_text", "browser_tools_pick"]` | Case-insensitive substrings matched against the tool name. A tool whose name contains any entry is treated as blocking mid-execution. |

Patterns are matched as substrings, so `browser_tools_click` matches both `mcp__browser_tools_click` and the longer `mcp__browser_tools_chrome_browser_tools_click` form produced by some MCP mounts.

## Install

```text
/marketplace install herdr-interactive-tool-block@erikh3-omp-marketplace
```

Restart omp after installation because extension modules load at startup. The Herdr omp integration must also be installed (`herdr integration install omp`) for the pane state to update.

## Development

```bash
bun install
bun test
bun run typecheck
omp plugin link ./plugins/herdr-interactive-tool-block
```

Restart omp after linking. Then, inside a Herdr pane, trigger a `browser-tools` `click` and confirm the pane shows `blocked` while the approval dialog is open:

```bash
herdr agent get <this-agent>
```

## Boundaries

The plugin only emits block signals on the shared bus. It depends on the Herdr-managed omp integration to translate those signals into pane state; without that integration it does nothing visible. Outside Herdr it is inert.

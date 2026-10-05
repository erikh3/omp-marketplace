# herdr-interactive-tool-block

Report the Herdr pane as **blocked** while a rule says the agent is waiting on the user mid-execution, instead of leaving it stuck in `working`.

## The problem

omp approves a tool at its own approval gate and then runs it. Some tools then wait on the user from inside their own execution: a browser-tools `click` blocks in the MCP server waiting for a Chrome confirmation, a difit or Plannotator review waits for the human to finish reviewing. omp still sees the tool executing, so the Herdr-managed omp integration keeps the pane in `working`.

The managed integration (`~/.omp/agent/extensions/herdr-omp-agent-state.ts`) only treats omp's own approval gate and the `ask` tool as blocking. These mid-execution waits slip through.

## How it works

The plugin runs a set of **rules**. Each rule inspects every starting tool call and either returns a label (block the pane for this call) or ignores it. A shared engine owns the lifecycle: it opens at most one block per `toolCallId`, emits `herdr:blocked` `{ active, label }` on the shared `pi.events` bus when a block opens, and emits `{ active: false }` when the call ends. The Herdr-managed omp integration ref-counts those events into the pane state. This plugin cooperates with that ref-count rather than reporting to Herdr directly.

- Runs only inside a Herdr-managed pane (`HERDR_ENV=1`).
- Watches the main omp session only. Subagents cannot change the pane state.
- Tracks each tool call by id, so overlapping or interleaved calls each open and close their own block.
- Clears any still-open block on session shutdown, so a crash mid-wait does not strand the pane in `blocked`.

## Built-in rules

| Rule id | Blocks when | Label |
| --- | --- | --- |
| `browser-tools` | An interactive browser-tools call starts (default ops `click`, `input_text`, `pick`). Matches the `browser_tools_` MCP segment under either mount name form. | Tool call intent, else a tidied tool name. |
| `difit` | A `difit` or `npx difit` launch bash command starts, or the legacy `hub(op="wait", name="difit")` call. | `difit review` |
| `plannotator` | A `plannotator review` or gated `plannotator annotate` bash command starts, or a `hub` wait for a session started with `application=plannotator` (or any `plannotator`-prefixed name). | `plannotator review` |
| `remote-shell` | A `remote-shell send-text` or `remote-shell wait-output` bash command starts. Both wait on the human, who alone presses Enter to submit the staged remote command. The non-waiting subcommands (`layout`, `select`, `read`, `reset`, `dismiss-pager`) are ignored. | `remote shell` |

The `difit` and `plannotator` rules were previously separate loose extensions in `~/.omp/agent/extensions/`. They now live here as modules.

## Adding a rule

Drop one file in `src/rules/`. No other file changes. Keep each rule to a single concern; split mixed concerns into separate rule files.

The file must **default-export** a factory that returns a `BlockRule`. Every `*.ts` in `src/rules/` except `index.ts` and `types.ts` is discovered and loaded at startup:

```typescript
import type { BlockRule } from "./types.ts";

export default function myRule(): BlockRule {
	return {
		id: "my-rule",
		onToolStart(event) {
			// return a label to block, or undefined to ignore.
			return event.toolName === "mcp__my_tool" ? "my tool waiting" : undefined;
		},
	};
}
```

That is the whole wiring step. The rule is enabled by default; a user disables it with `rules: { "my-rule": false }`. If the rule reads a setting, accept the resolved `BlockConfig` as the factory argument (as `browser-tools` does) and add the setting to `BlockConfig`/`loadConfig` in `src/config.ts` plus `package.json`; a rule that needs no config ignores the argument.

A rule may keep private state across calls, for example to correlate a later `hub` wait with an earlier start, as the `plannotator` rule does. A malformed rule file (no default function, or a factory that throws) is skipped with a logged warning, so one bad rule never disables the others.

## Configuration

| Setting | Type | Default | Description |
| --- | --- | --- | --- |
| `enabled` | boolean | `true` | Master switch. When off, no block is reported. |
| `rules` | object | `{ "browser-tools": true, "difit": true, "plannotator": true }` | Per-rule enablement. Set a rule id to `false` to disable it. |
| `browserToolsOps` | array | `["click", "input_text", "pick"]` | Interactive browser-tools op names for the `browser-tools` rule. |

The `browser-tools` rule matches the `browser_tools_` MCP segment plus an op name, so `click` matches both `mcp__browser_tools_click` and the longer `mcp__browser_tools_chrome_browser_tools_click` form produced by some MCP mounts.

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

Restart omp after linking. Then, inside a Herdr pane, trigger a `browser-tools` `click` (or a difit / Plannotator review) and confirm the pane shows `blocked` while it waits:

```bash
herdr agent get <this-agent>
```

## Boundaries

The plugin only emits block signals on the shared bus. It depends on the Herdr-managed omp integration to translate those signals into pane state; without that integration it does nothing visible. Outside Herdr it is inert.

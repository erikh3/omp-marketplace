# AGENTS.md: herdr-interactive-tool-block

Guidance for AI agents editing this plugin. User-facing behavior, config, and install live in `README.md`; read it first. This file covers architecture, invariants, and the verification contract.

## What this plugin does

Emits `herdr:blocked` `{ active, label }` on the shared `pi.events` bus so the Herdr-managed omp integration (`~/.omp/agent/extensions/herdr-omp-agent-state.ts`) reports the pane as `blocked` while a tool waits on the user mid-execution. The plugin never talks to Herdr directly. It cooperates with that integration's ref-count.

## File map

| File | Responsibility |
| --- | --- |
| `src/index.ts` | Extension factory. Env + main-session guards, config load, wires events to the engine. The only file that touches `pi.*`. |
| `src/engine.ts` | `BlockEngine`. Owns block lifecycle: runs rules on each start, one block per `toolCallId`, emits signals, clears on shutdown. No omp or Herdr knowledge. |
| `src/config.ts` | Settings load and defaults. `RULE_IDS`, `BlockConfig`, per-rule toggles, pattern parsing. |
| `src/rules/types.ts` | `BlockRule` and `ToolStartInfo` contracts, shared `isObject` guard. |
| `src/rules/index.ts` | `RULE_FACTORIES` registry and `buildRules(config)`. |
| `src/rules/{interactive-tools,difit,plannotator}.ts` | One rule each. Pure classification, no bus or omp access. |

Dependency direction: `index` -> `engine` + `config` + `rules/index` -> individual rules -> `types`. Keep it acyclic. Rules must not import `index`, `engine`, or `pi.*`.

## Invariants (do not break)

1. **One signal pair per block.** The engine emits exactly one `{ active: true }` when a block opens and one `{ active: false }` when it closes. The managed integration ref-counts these; an unbalanced emit corrupts the pane state. Never emit `herdr:blocked` from anywhere but `BlockEngine`.
2. **One block per `toolCallId`.** A second start for an already-open call id is ignored. An end for an unknown id is ignored.
3. **Rules run on every start, even after a match.** Stateful rules (for example `plannotator` tracking hub sessions) must observe all starts. The engine keeps calling later rules after one returns a label; only the first non-empty label is reported.
4. **Main session only.** Subagents must not change pane state. The `agent.kind === "main"` guard in `index.ts` enforces this; keep it.
5. **Rules are pure classifiers.** `onToolStart` returns a label or `undefined`. It may hold private per-instance state but must have no external side effects (no I/O, no bus emit).
6. **Inert outside Herdr.** `index.ts` returns early unless `HERDR_ENV=1`.

## Adding or changing a rule

1. Add `src/rules/<id>.ts` exporting a factory `(): BlockRule` (or `(config) => BlockRule` if it needs settings).
2. Register the id in `RULE_FACTORIES` (`src/rules/index.ts`) and in `RULE_IDS` plus the default `rules` map (`src/config.ts`).
3. Add a rule-module test under `test/rules/<id>.test.ts` that calls `onToolStart` directly with representative and non-matching events. Also assert any per-instance state does not leak across instances.
4. Update `README.md` built-in rules table and `package.json` `omp.settings.rules` default.
5. Bump `package.json` version (minor for a new rule, per `.agents/references/marketplace-conventions.md`).

The `difit` and `plannotator` rules were ported from standalone extensions in `~/.omp/agent/extensions/`. Preserve their matching logic exactly (the `plannotator` command regex and hub-session correlation) when touching them.

## Verification contract

Run from this directory:

```bash
bun run typecheck
bun test
```

Then from the repository root:

```bash
bun scripts/validate-marketplace.ts
```

Unit tests cover rule classification, engine lifecycle (bracketing, overlap, first-label-wins, clear), and factory wiring. They do NOT prove the cross-extension contract. For that, run an end-to-end check: load this plugin and the real managed omp extension on one shared bus, point `HERDR_SOCKET_PATH` at a throwaway unix socket that records `pane.report_agent`, drive `session_start` -> `agent_start` -> `tool_execution_start` -> `tool_execution_end`, and assert the state sequence reaches `blocked` during the call and returns to `working`/`idle` after. Delete the throwaway script afterward. A green unit suite with no socket-level check is not sufficient evidence for a behavior change here.

## Gotchas

- `pi.events` is one shared bus per session, injected into every extension. The channel name `herdr:blocked` and payload shape `{ active, label }` are a contract with the managed integration. Do not rename or restructure them without changing that integration too.
- The managed integration special-cases omp's own approval gate and the `ask` tool. This plugin covers the gap for tools that wait from inside their own execution. Do not add rules for the `ask` tool or omp's gate; they would double-count.
- Config loads asynchronously. `index.ts` builds the engine eagerly from `DEFAULT_CONFIG`, then rebuilds on `session_start` once settings resolve, so blocks still work before the first config load completes.
- Tool names vary by MCP mount: `mcp__browser_tools_click` and `mcp__browser_tools_chrome_browser_tools_click` are the same tool. The `interactive-tools` rule matches substrings for this reason.

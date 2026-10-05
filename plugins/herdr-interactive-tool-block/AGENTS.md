# AGENTS.md: herdr-interactive-tool-block

Guidance for AI agents editing this plugin. User-facing behavior, config, and install live in `README.md`; read it first. This file covers architecture, invariants, and the verification contract.

## What this plugin does

Emits `herdr:blocked` `{ active, label }` on the shared `pi.events` bus so the Herdr-managed omp integration (`~/.omp/agent/extensions/herdr-omp-agent-state.ts`) reports the pane as `blocked` while a tool waits on the user mid-execution. The plugin never talks to Herdr directly. It cooperates with that integration's ref-count.

## File map

| File | Responsibility |
| --- | --- |
| `src/index.ts` | Extension factory. Env + main-session guards, config load, wires events to the engine. The only file that touches `pi.*`. |
| `src/engine.ts` | `BlockEngine`. Owns block lifecycle: runs rules on each start, one block per `toolCallId`, emits signals, clears on shutdown. No omp or Herdr knowledge. |
| `src/config.ts` | Settings load and defaults. `BlockConfig`, sparse per-rule toggles, op-list parsing. Rule-agnostic: holds no rule id list. |
| `src/rules/types.ts` | `BlockRule` and `ToolStartInfo` contracts, shared `isObject` guard. |
| `src/rules/index.ts` | Rule loader: `discoverRuleFactories` (glob + dynamic import), `instantiateRules` (pure), `buildRules`. `RuleFactory` type. |
| `src/rules/{browser-tools,difit,plannotator}.ts` | One rule each. Pure classification, no bus or omp access. Each default-exports a `RuleFactory`. |

Dependency direction: `index` -> `engine` + `config` + `rules/index`; rule files -> `config` (type-only) + `types`. Keep it acyclic. Rules must not import `index`, `engine`, or `pi.*`. `rules/index.ts` imports rule files only dynamically (discovery), never statically.

## Invariants (do not break)

1. **One signal pair per block.** The engine emits exactly one `{ active: true }` when a block opens and one `{ active: false }` when it closes. The managed integration ref-counts these; an unbalanced emit corrupts the pane state. Never emit `herdr:blocked` from anywhere but `BlockEngine`.
2. **One block per `toolCallId`.** A second start for an already-open call id is ignored. An end for an unknown id is ignored.
3. **Rules run on every start, even after a match.** Stateful rules (for example `plannotator` tracking hub sessions) must observe all starts. The engine keeps calling later rules after one returns a label; only the first non-empty label is reported.
4. **Main session only.** Subagents must not change pane state. The `agent.kind === "main"` guard in `index.ts` enforces this; keep it.
5. **Rules are pure classifiers.** `onToolStart` returns a label or `undefined`. It may hold private per-instance state but must have no external side effects (no I/O, no bus emit).
6. **Inert outside Herdr.** `index.ts` returns early unless `HERDR_ENV=1`.
7. **Rule discovery is isolated.** `discoverRuleFactories` and `instantiateRules` skip a malformed or throwing rule file with a warning instead of failing the extension. One bad rule must never disable the others or crash load.

## Adding or changing a rule

One rule is one file, one concern. Split mixed concerns into separate rule files.

1. Add `src/rules/<id>.ts` that **default-exports** a `RuleFactory` (`(config) => BlockRule`; ignore the argument if the rule needs no config). The returned rule carries its own `id`. Discovery picks it up automatically; there is no registry to edit.
2. If the rule needs a setting, add a field to `BlockConfig` and parse it in `loadConfig` (`src/config.ts`), plus the matching `omp.settings` entry in `package.json`. Do not add the rule id anywhere; enablement is implicit (on unless `rules.<id>` is `false`).
3. Add a rule-module test under `test/rules/<id>.test.ts` that calls the factory's rule `onToolStart` directly with representative and non-matching events. Assert any per-instance state does not leak across instances.
4. Update the `README.md` built-in rules table and, when a default changes, `package.json` `omp.settings`.
5. Bump `package.json` version (minor for a new rule, per `.agents/references/marketplace-conventions.md`).

Discovery runs once per process (`discoverRuleFactories`), then `index.ts` re-instantiates from the cached factories on each `session_start`. Do not reintroduce a hardcoded factory map; that was removed on purpose so a new rule is a single file.

The `difit` and `plannotator` rules were ported from standalone extensions in `~/.omp/agent/extensions/`. `difit` now also matches a `difit`/`npx difit` launch bash command, since difit no longer routes through a `hub` session in current setups; the `hub` wait match is kept as a fallback. Preserve the `plannotator` command regex and hub-session correlation when touching that rule.

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

Unit tests cover rule classification, engine lifecycle (bracketing, overlap, first-label-wins, clear), and factory wiring. They do NOT prove the cross-extension contract. For that, run a live check: start a real omp in a Herdr pane (the plugin runs from the linked checkout), have it issue a `browser-tools` click, and confirm `herdr pane list` reports the pane `blocked` while the click waits, then `working` after. A green unit suite is not sufficient evidence for a behavior change here, because the unit tests fire synthetic events; only a live omp proves omp actually delivers the hooked events for the targeted tool class.

## Gotchas

- `pi.events` is one shared bus per session, injected into every extension. The channel name `herdr:blocked` and payload shape `{ active, label }` are a contract with the managed integration. Do not rename or restructure them without changing that integration too.
- The managed integration special-cases omp's own approval gate and the `ask` tool. This plugin covers the gap for tools that wait from inside their own execution. Do not add rules for the `ask` tool or omp's gate; they would double-count.
- Rules are discovered on disk via `Bun.Glob` + dynamic `import()` relative to `import.meta.dir`, which works because omp loads the extension from its real source file, not a flat bundle. Discovery is async, so engine construction is async: `index.ts` caches the discovered factories once, starts with no engine, and builds it on the first `rebuildEngine()` (a few ms at load) and again per `session_start` once settings resolve.
- Tool names vary by MCP mount: `mcp__browser_tools_click` and `mcp__browser_tools_chrome_browser_tools_click` are the same tool. The `browser-tools` rule matches the `browser_tools_` segment plus an op name for this reason.
- Lifecycle hooks are `tool_call` (pre-execution) and `tool_result` (post), NOT `tool_execution_start`/`end`. Verified against omp 18.6.1: `tool_execution_start`/`end`/`update` and `tool_approval_requested`/`resolved` fire for native tools ONLY, never for MCP tool calls like browser-tools. `tool_call`/`tool_result` fire for both. Since browser-tools is the main case, the execution events are useless here. Do not "simplify" back to them. `tool_call`/`tool_result` carry the tool input under `input` (not `args`), and browser-tools' `intent` is a tool parameter inside `input`, so `index.ts` maps `args: event.input` and reads `intent` from `input.intent`.

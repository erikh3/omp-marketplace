# session-autoname

Name the current session from its own logs with one keystroke, using the same
smol model omp already uses for automatic titling.

## Commands

| Input | Action |
|-------|--------|
| `/name` | Generate a name from the session logs via the smol model |
| `/name <title>` | Set the name to `<title>` verbatim (trimmed) |
| `/rename` | Generate a name from the session logs via the smol model |
| `/rename <title>` | Unchanged — handled by omp's built-in `/rename` |

The distinction is only the presence of an argument: **no argument → generate;
argument → set directly.**

## Why

omp derives a session's automatic title from the *first* user message. Long
sessions drift off that first topic, and the built-in `/rename` requires you to
type a title yourself. This plugin re-derives a short name from the *current*
transcript on demand, so a session that started as "help me read a log" and
became "rewrite the retry backoff" can be renamed to match without you inventing
a title.

## How it works

Three mechanisms, each dictated by an omp constraint:

- **`/name` is registered as a command** (`pi.registerCommand`). It is not a
  built-in, so it is free to register, shows up in autocomplete/help, and works
  in interactive, ACP, and RPC modes.
- **`/rename` is a reserved built-in** and cannot be re-registered — omp skips
  extension commands that collide with built-in names. Its no-argument form is
  therefore intercepted on the **`input` event**, which fires *before*
  slash-command dispatch; returning `{ handled: true }` preempts the built-in's
  usage error. Only a bare `/rename` (optionally surrounded by whitespace) is
  intercepted. `/rename <title>` and everything else fall straight through.
- **Name generation reuses omp's own titling engine.** The transcript is read
  from `sessionManager.getEntries()`, condensed with `buildReplanTitleContext`
  (the same recent-turns digest omp feeds its post-replan title refresh), and
  passed to `generateSessionTitle`. That honors the `providers.tinyModel`
  setting: a local tiny worker or the online `@smol` role. No online fallback is
  forced.

The generated (or supplied) name is stored via `pi.setSessionName`, which
records source `user`, so a later automatic title will not overwrite it.

### Edge cases

- **Too little signal** (session just started, or only non-message entries
  exist): the model is never called and a notice explains there is nothing to
  name yet.
- **Model declines** (returns null/empty) or **errors**: the session is left
  unnamed and a notice is shown; the transient status line is always cleared.
- **`/Rename` / `/renamed`**: not intercepted. Slash commands are lowercase and
  the match is exact, so only a real bare `/rename` triggers generation.

## Configuration

None of its own. The title model is whatever `providers.tinyModel` resolves to
in your omp settings — the same knob that drives automatic session titling. If
that model is unavailable, generation is skipped rather than billed against an
unexpected provider.

## Install

```
bun i
bun run typecheck
omp plugin link ./plugins/session-autoname
```

Restart the session after linking — extension modules load at startup.

Marketplace install (snapshot; re-run `upgrade` to pick up edits):

```
/marketplace install session-autoname@erikh3-omp-marketplace
```

## Development

```
bun i
bun run typecheck   # tsc --noEmit
bun test            # routing + auto-naming coverage
```

The test suite mocks `generateSessionTitle` via `mock.module`, so the
auto-naming paths (success, decline, throw, empty transcript) are exercised
without a real model call.

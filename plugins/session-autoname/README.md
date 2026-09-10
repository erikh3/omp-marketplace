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
type a title yourself. This plugin re-derives a specific, searchable name from
the current active branch. Names preserve concrete identifiers such as plugin,
service, repository, ticket, environment, error, and version names instead of
collapsing the session into labels like "Version Upgrade" or "Investigation".
URLs, hostnames, links, and filesystem or repository paths are removed from the
final title; their useful component names remain as plain search terms.

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
- **Name generation reflects the active branch.** The path from the current
  session leaf to its root is read from `sessionManager.getBranch()` and rendered
  as `User:`/`Assistant:` turns. Abandoned sibling branches are excluded. For
  long transcripts, the current session model generates the final title directly
  from up to 24,000 characters under a prompt that requires the concrete subject,
  action, outcome, and distinguishing identifiers. This avoids losing exact names
  in a summarize-then-title handoff. Short transcripts and long-session failures
  fall back to `generateSessionTitle`, with the same searchable-title rules. That
  fallback honors `providers.tinyModel` and never forces an online model.

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

The test suite mocks both `generateSessionTitle` and the summary model
(`completeSimple` from `@oh-my-pi/pi-ai`) via `mock.module`, so the auto-naming
paths — success, decline, throw, empty transcript, whole-transcript coverage,
and the summarize-then-title pass with its no-model / summary-error fallbacks —
are exercised without a real model call.

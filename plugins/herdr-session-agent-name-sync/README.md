# herdr-session-agent-name-sync

Keep the current Herdr agent name synchronized with the omp session title.

When omp assigns its first automatic title or `/rename` changes it, the plugin converts that title to a valid Herdr agent name and runs `herdr agent rename` for the current pane. For example, `Herdr OMP Agent Name Plugin` becomes `herdr-omp-agent-name-plugin`.

## Behavior

- Runs only inside a Herdr-managed pane with `HERDR_ENV=1` and `HERDR_PANE_ID` set.
- Watches the main omp session only. Internal task and eval subagents cannot rename the parent pane.
- Reacts to automatic titles, explicit `/rename` calls, RPC renames, and session switches.
- Clears the Herdr agent name when omp switches to a new unnamed session.
- Converts titles to lowercase ASCII names accepted by Herdr, with a 32-character limit.
- Retries a rejected name with a pane-specific suffix, which resolves collisions between sessions with the same title.
- Logs failures through the omp logger without interrupting the session.

Current omp versions expose an internal session-name change callback on the live session manager. The plugin feature-detects that callback for event-driven updates. On older versions without it, the plugin polls the public `getSessionName()` API every 500 ms.

## Configuration

None.

## Install

```text
/marketplace install herdr-session-agent-name-sync@erikh3-omp-marketplace
```

Restart omp after installation because extension modules load at startup.

## Development

```bash
bun install
bun test
bun run typecheck
omp plugin link ./plugins/herdr-session-agent-name-sync
```

Restart omp after linking. Rename the session with `/rename <title>`, then confirm the current agent name with:

```bash
herdr agent list
```

## Boundaries

The plugin controls the Herdr agent name while enabled. Manual Herdr renames remain in place until the omp session title changes or another session is loaded. Outside Herdr, the plugin does nothing.

# plugins-bin-to-path

Puts each enabled plugin's `bin/` directory on the Bash `PATH`, so bundled
executables such as `bg-gradle` and `session-inspect` run by bare name under omp.

Unlike Claude Code, omp does **not** natively add plugin `bin/` dirs to the Bash
tool's `PATH`. This extension fills that gap.

## Install

```
bun i
bun run typecheck   # tsc --noEmit
omp plugin link ./plugins/plugins-bin-to-path
```

Restart omp after linking.

## Design rationale

OMP's Bash executor gets its base environment from a process-wide cached
`getShellConfig()` object. Mutating only `process.env.PATH` is insufficient
because the shell environment was captured before extensions loaded.

The extension discovers both marketplace-installed plugins from
`installed_plugins.json` and locally linked plugins from `omp-plugins.lock.json`
plus `node_modules/`. It updates both environment locations during factory
initialization:

1. `pi.pi.settings.getShellConfig().env.PATH` supplies the Bash tool and `!`
   commands.
2. `process.env.PATH` supplies eval kernels and children spawned directly by
   extensions.

The cached shell configuration is shared by every session in the process.
Normal subagents therefore inherit the modified PATH. Restricted and plan-mode
subagents also receive it even though omp intentionally does not load extensions
inside those sessions.

The mutation is idempotent. Existing PATH entries retain their order, and each
enabled plugin `bin/` directory is added at most once.

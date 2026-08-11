# plugins-bin-to-path

Puts each enabled Claude Code plugin's `bin/` directory on the Bash `PATH`, so
bundled executables (e.g. `bg-gradle`) run by bare name under omp.

Unlike Claude Code, omp does **not** natively add plugin `bin/` dirs to the Bash
tool's `PATH`. This extension fills that gap.

## Two distributions

This repo ships the logic in two forms. Pick one — do not run both at once.

| Form | File | Mechanism | PATH rendering |
|------|------|-----------|----------------|
| **Top-level extension** (recommended) | `extensions/bin-to-path.ts` | one-shot `process.env.PATH` mutation at `session_start` | clean — no per-call `env` |
| **Marketplace plugin** | `src/plugins-bin-to-path.ts` | per-call `tool_call` `input.env` + `user_bash` result | renders `PATH=… command` on gated calls |

The top-level extension is preferred: it is simpler, has zero per-call overhead,
and never pollutes the rendered command line. The plugin form exists only for
users who need marketplace distribution/versioning and cannot drop a file into
`~/.omp/agent/extensions/`.

### Install the top-level extension

```
cp extensions/bin-to-path.ts ~/.omp/agent/extensions/bin-to-path.ts
```

Dropping the file **is** the enable step. Restart omp. Disable the marketplace
plugin if it was previously linked (`omp plugin disable plugins-bin-to-path`).

### Install the marketplace plugin (alternative)

```
bun i
bun run typecheck   # tsc --noEmit
omp plugin link ./plugins/plugins-bin-to-path
```

## Design rationale — omp's levers for the Bash PATH

Investigation of omp v17.2.12 (`dist/cli.js`) established which levers can put a
directory on the Bash tool's `PATH`, and — critically — that the answer depends
on **load order**.

### What omp does NOT provide

| Candidate | Verdict |
|-----------|---------|
| Native Claude-plugin `bin/` → PATH | Absent. `installPath` feeds package resolution / discovery / uninstall only, never PATH. |
| Settings knob (`bash.env` / PATH list) | None. Schema has `bash.enabled/patterns/direnv/direnvLoadTimeoutMs`, `shellMinimizer.*`, `bashInterceptor.*`, and `shellPath` — but `shellPath` swaps the shell **binary**, not the env. |
| `plugin.json` `bin` field | Not a known manifest field (`$schema, name, version, description, author, homepage, repository, license, keywords, extensions`). |
| `hooks/{pre,post}` | Policy gates only (allow/deny/prompt). Output is a permission decision, not an env/command mutation. Not the Claude Code SessionStart env-emitting hook set. |
| `pi.exec(cmd, args, opts)` | `ExecOptions` has no `env`; runs the extension's own subprocess, not the bash tool. |
| `ExtensionAPI.setEnv` / `registerShellEnv` | No such method exists. |

### The mechanism, and why load order decides everything

The Bash tool builds each command's environment from `getShellConfig().env`,
which reads live `process.env` (`Bun.env`) — **but** the persistent shell caches
its environment at first spawn, keyed by session.

- A **top-level extension** (`~/.omp/agent/extensions/*.ts`) loads *before* that
  first shell spawn. A single `process.env.PATH` mutation at `session_start`
  therefore lands on both the model `bash` tool and the `!` bang shell. One
  write, no per-call work. (Verified: `bg-gradle` resolves on both surfaces.)
- A **marketplace plugin** loads *after* the shell env is captured. The same
  `process.env` mutation reaches neither surface (verified: agent tool
  `command -v` exit 1, bang `PATH` dev-tools count 0). A plugin therefore has
  only two levers that reach the Bash tool, and must use both:
  - `tool_call` → return `{ input: { …, env: { PATH } } }`: the executor layers
    `input.env` on top with precedence. Renders as `PATH=… command`.
  - `user_bash` → return `{ result }`: full replacement of bang execution; the
    plugin re-runs the command through a login shell with `PATH` prepended.

Both plugin handlers are gated on `commandUsesBinary` so only commands that
actually reference a bundled executable are touched; unrelated calls render
clean and run natively.

### Conclusion

For a marketplace **plugin**, the two-handler (`tool_call` + `user_bash`) design
is the only viable approach — omp exposes no env/PATH lever a plugin can set
once. The clean one-shot `process.env.PATH` mutation is available **only** to a
top-level extension, which is why that is the recommended form.

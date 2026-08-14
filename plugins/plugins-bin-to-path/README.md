# plugins-bin-to-path

Puts each enabled Claude Code plugin's `bin/` directory on the Bash `PATH`, so
bundled executables (e.g. `bg-gradle`) run by bare name under omp.

Unlike Claude Code, omp does **not** natively add plugin `bin/` dirs to the Bash
tool's `PATH`. This extension fills that gap.

## Install

```
bun i
bun run typecheck   # tsc --noEmit
omp plugin link ./plugins/plugins-bin-to-path
```

Restart omp after linking.

## Design rationale — omp's levers for the Bash PATH

Investigation of omp v17 (`dist/cli.js`) established which levers can put a
directory on the Bash tool's `PATH`.

### What omp does NOT provide

| Candidate | Verdict |
|-----------|---------|
| Native Claude-plugin `bin/` → PATH | Absent. `installPath` feeds package resolution / discovery / uninstall only, never PATH. |
| Settings knob (`bash.env` / PATH list) | None. Schema has `bash.enabled/patterns/direnv/direnvLoadTimeoutMs`, `shellMinimizer.*`, `bashInterceptor.*`, and `shellPath` — but `shellPath` swaps the shell **binary**, not the env. |
| `plugin.json` `bin` field | Not a known manifest field (`$schema, name, version, description, author, homepage, repository, license, keywords, extensions`). |
| `hooks/{pre,post}` | Policy gates only (allow/deny/prompt). Output is a permission decision, not an env/command mutation. Not the Claude Code SessionStart env-emitting hook set. |
| `pi.exec(cmd, args, opts)` | `ExecOptions` has no `env`; runs the extension's own subprocess, not the bash tool. |
| `ExtensionAPI.setEnv` / `registerShellEnv` | No such method exists. |

### Why a one-shot `process.env.PATH` mutation is not enough

An earlier design tried a single `process.env.PATH` mutation at `session_start`,
on the theory that the extension loads before omp's persistent shell spawns, so
the mutation would be inherited by both the model `bash` tool and the `!` bang
shell. **That assumption is false in practice.**

omp's persistent shell derives its environment from a cached login-shell
snapshot, and the shell process is a project-scoped daemon that is **reused
across omp invocations** — it is typically spawned by an earlier session, long
before the current session's `session_start` runs. The live `process.env`
mutation therefore never reaches it. (Verified: after `session_start`, the
plugin `bin/` dirs are present in the `eval` kernel's `process.env.PATH` but
absent from the `bash` tool's shell PATH, and `bg-gradle` fails with exit 127.)

The mutation does still reach surfaces that read the live `process.env` in this
process — the `eval` JS/Python kernels and children an extension spawns — so the
plugin keeps it for those, but it cannot be the mechanism for the Bash tool.

### The two levers that actually reach the Bash surfaces

| Surface | Hook | Mechanism |
|---------|------|-----------|
| Model `bash` tool | `tool_call` | return `{ input: { …, env: { PATH } } }`; the executor layers `input.env` on top with precedence (renders as `PATH=… command`) |
| `!` bang shell | `user_bash` | return `{ result }`; the command is re-run through a login shell (`getShellConfig()`) with `PATH` prepended |

Injecting `env.PATH` **replaces** the shell PATH wholesale (no `$PATH`
expansion of the injected value), so the base is seeded from the launch
`process.env.PATH` — a superset of the shell's snapshot PATH — which preserves
every dir the shell needs while adding the bundled bin dirs.

Both handlers are gated on `commandUsesBinary` so only commands that actually
reference a bundled executable are touched; unrelated calls render clean and run
natively.

### Conclusion

omp exposes no env/PATH lever a plugin can set once for the Bash tool. The
per-call two-handler design (`tool_call` + `user_bash`), gated on
`commandUsesBinary`, is the only reliable approach.

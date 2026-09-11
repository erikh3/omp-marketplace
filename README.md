# omp-marketplace

Personal [oh-my-pi](https://omp.sh) plugin marketplace.

Catalog: [`.omp-plugin/marketplace.json`](.omp-plugin/marketplace.json).

## Add the marketplace

From GitHub:

```
/marketplace add erikh3/omp-marketplace
```

From a local git clone (point at the checkout directory):

```
/marketplace add ./omp-marketplace
```

CLI equivalents:

```
omp plugin marketplace add erikh3/omp-marketplace
omp plugin marketplace add ~/Personal/omp-marketplace
```

A local source is any path starting with `./`, `~/`, or `/` that contains
`.omp-plugin/marketplace.json`.

## Plugins

| Plugin | Description |
| --- | --- |
| [`plugins-bin-to-path`](plugins/plugins-bin-to-path) | Puts each enabled omp plugin's `bin/` directory on the Bash tool PATH, so bundled executables run by bare name under omp. |
| [`session-autoname`](plugins/session-autoname) | Auto-name the session from its logs via the smol model when `/name` or `/rename` is issued without a title. |
| [`obsidian-welcome`](plugins/obsidian-welcome) | Shows an animated Obsidian welcome widget only when omp runs inside an Obsidian vault. Includes daily-note status and recent notes. |
| [`context-injector`](plugins/context-injector) | Inject skills and arbitrary file contents into the LLM context at agent-start time. Supports `skill://` URIs, filesystem paths, and globs. |
| [`unslop-pr`](plugins/unslop-pr) | TTSR rules that intercept PR creation and update calls and force the agent to load the `unslop` skill before writing PR titles or descriptions. |
| [`omp-permission-guard`](https://github.com/erikh3/omp-permission-guard) | External source (fork of `hank-warren/omp-permission-guard`, pinned to a reviewed commit). Classifier-based tool-approval gate (heuristic / guardian / hybrid). |
| [`git-commit-linter`](plugins/git-commit-linter) | Validates model-issued `git commit` messages against commitlint rules before Bash executes. Enforces Conventional Commits by default; defers to repository commitlint config when present. |
| [`github-comment-guard`](plugins/github-comment-guard) | Blocks replies to human-authored GitHub review comments while allowing bot replies and new top-level comments. |
| [`hai-proxy-companion`](plugins/hai-proxy-companion) | Shows HAI Proxy spend estimates and context growth below the prompt. Stops omp cleanly with a cap-hit message when HAI returns `DAILY_CAP_EXCEEDED`. |

> **Vim mode is now built into omp.** The `pi-vim` plugin has been retired. Enable it with `/vim on` or `vim: true` in your omp config.

## Install a plugin

Pick a plugin from the table above and install it by `name@erikh3-omp-marketplace`:

```
/marketplace install <name>@erikh3-omp-marketplace
```

CLI equivalent:

```
omp plugin install <name>@erikh3-omp-marketplace
```

The marketplace suffix (`erikh3-omp-marketplace`) is the `name` field in
[`.omp-plugin/marketplace.json`](.omp-plugin/marketplace.json), not the repo name.

Restart the session after installing: extension modules load at startup.

See each plugin's own README for configuration.

## Development

Both marketplace paths above install a **snapshot**: `install` copies the plugin
into omp's cache (`~/.omp/plugins/cache/`) and symlinks it into `node_modules`,
so later edits to your working copy are **not** reflected — even when the
marketplace source is a local clone. To pick up edits you would re-run
`omp plugin upgrade <name>@erikh3-omp-marketplace`.

For iterating on plugin code, link the working directory instead — omp then runs
it live from your checkout:

```
omp plugin link ./plugins/<name>
```

This symlinks `~/.omp/plugins/node_modules/<name>` → your checkout, so edits load
directly. Restart the session after linking or after any edit: extension modules
load at startup. See [`plugins/<name>/README.md`](plugins) for per-plugin dev
commands (typecheck, etc.).

For the full command set (scopes, upgrade, enable/disable, uninstall), see the
[omp marketplace docs](https://github.com/can1357/oh-my-pi/blob/main/docs/marketplace.md).

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
| [`claude-plugin-bin-path`](plugins/claude-plugin-bin-path) | Puts each enabled Claude Code plugin's `bin/` directory on the Bash tool PATH, so bundled executables run by bare name under omp. |

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

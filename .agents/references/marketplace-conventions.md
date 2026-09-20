# Marketplace conventions

## Sources of truth

- `.omp-plugin/marketplace.json` defines installable plugins.
- A local plugin's `package.json` defines its identity, version, extension entry points, settings, and scripts.
- The root `README.md` lists active marketplace entries and installation commands.
- A plugin `README.md` documents that plugin's behavior, configuration, development commands, and known boundaries.

Do not copy OMP's complete marketplace or extension documentation into this repository. Check the current upstream documentation when changing a format or API:

- https://github.com/can1357/oh-my-pi/blob/main/docs/marketplace.md
- https://github.com/can1357/oh-my-pi/blob/main/docs/extensions.md
- https://github.com/can1357/oh-my-pi/blob/main/docs/extension-loading.md

## Plugin boundaries

Each plugin owns one cohesive behavior and must remain usable without another marketplace plugin. Shared assumptions between plugins create hidden installation-order and enablement dependencies. If two behaviors can be enabled independently, keep them in separate plugins.

## Local plugins

Local catalog entries use a relative source under `plugins/`. For each active local plugin:

- directory name, catalog name, and `package.json#name` must match
- `package.json#version` is the version source; omit the redundant catalog `version`
- every `package.json#omp.extensions` path must resolve inside the plugin directory
- extension entry points use TypeScript or JavaScript and export an OMP extension factory
- add or update the root README row when the catalog name or description changes
- document behavior, configuration, development commands, and important boundaries in the plugin README

Directories under `plugins/` need not be active catalog entries. Samples, retired plugins, and locally retained sources may remain unlisted.

## External plugins

External Git sources must include:

- an exact Git commit in `source.sha`
- an explicit `version`
- `author`
- `repository`
- `homepage`
- an SPDX license identifier in `license`

For GitHub sources, use `source.repo`. For generic Git repositories, use `source.url`. A branch or tag in `source.ref` may document the upstream line, but it never replaces the immutable commit pin.

`source.sha` is a Git commit identifier. It is not a SHA-256 archive checksum. Do not add unsupported integrity fields to the catalog.

Before updating an external pin:

1. Review the source diff from the current commit to the proposed commit.
2. Confirm the version and license metadata.
3. Validate installation and loading from the pinned commit.
4. Describe untested runtime behavior in the pull request.

## Versioning

Bump the local plugin version whenever installed plugin content changes.

| Change | Bump |
| --- | --- |
| Compatible fix or shipped documentation correction | patch |
| New compatible behavior, command, setting, or capability | minor |
| Removed or incompatible behavior | major |

For `0.x` plugins, use a minor bump for an incompatible change until the plugin declares a stable `1.0.0` contract. State the incompatibility in the pull request.

Catalog-only metadata corrections do not require local plugin version changes unless they alter the installed plugin or update behavior.

## Documentation

Keep documentation close to its subject:

- root README: marketplace setup, installation, active plugin summary
- plugin README: behavior, configuration, development, verification, boundaries
- source comments: non-obvious invariants only

Do not duplicate plugin internals in the root README. Do not add a plugin README section that merely restates source code.

## Verification

Use each plugin's `package.json#scripts` as the command source of truth:

- run `bun test` from the plugin directory when a `test` script exists
- run `bun run typecheck` from the plugin directory when a `typecheck` script exists
- run additional scripts only when the changed behavior requires them

Tests and type checking do not prove extension loading or interaction. For runtime behavior, link the plugin with `omp plugin link ./plugins/<name>`, restart OMP, and exercise the changed path. `/reload-plugins` can refresh skills, commands, and MCP servers, but newly installed tools, hooks, and extension modules require a restart.

Finish every catalog or plugin change with:

```bash
bun scripts/validate-marketplace.ts
```

## Commits

Use Conventional Commits. Plugin-specific commits use the plugin name as scope:

```text
feat(context-injector): add project entry filtering
fix(github-comment-guard): block pending review comments
```

Marketplace-wide documentation or tooling may omit a scope:

```text
docs: add marketplace conventions
chore: validate marketplace catalog
```

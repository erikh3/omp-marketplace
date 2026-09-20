# omp-marketplace

Personal Oh My Pi plugin marketplace. Local plugins live under `plugins/<name>/`; `.omp-plugin/marketplace.json` is the catalog.

## Before editing

Read `.agents/references/marketplace-conventions.md` before:

- adding, removing, renaming, or upgrading a plugin
- changing `.omp-plugin/marketplace.json`
- changing a plugin `package.json`
- updating an external plugin source

Load `.agents/skills/validate-marketplace/SKILL.md` after changing the catalog or any installed plugin content and before committing.

## Required verification

For each changed local plugin:

1. Run its `test` script when present.
2. Run its `typecheck` script when present.
3. Exercise changed runtime behavior through OMP.
4. Run `bun scripts/validate-marketplace.ts` from the repository root.

For catalog-only or marketplace-documentation changes, run `bun scripts/validate-marketplace.ts`.

## Core rules

- Keep each plugin responsible for one cohesive behavior.
- Local plugin names must match their directory and `package.json` name.
- Local plugin versions come from `package.json`; do not duplicate them in the catalog.
- Bump a local plugin version whenever installed plugin content changes.
- Pin external Git sources to an exact Git commit SHA.
- Update the root README when adding, removing, or renaming a catalog entry.
- Update the nearest plugin README when behavior, configuration, or development commands change.
- Use Conventional Commits. Use the plugin name as scope for plugin-specific changes.
- Do not require inactive plugin directories to remain in the catalog. Retired and sample plugins may stay in the tree.

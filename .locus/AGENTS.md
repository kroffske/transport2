# .locus directory map

This file routes reads and writes under `.locus/`. It is not a repository-wide
instruction file or a catalogue of every document.

- Read root `AGENTS.md` for repository rules and major paths.
- Read `<docs-root>/AGENTS.md` or `<docs-root>/index.md` for published
  documentation.
- Read `.tasks/<task>/task.md` for active execution state and evidence links.

## Memory families

Families are lazy: a path may be absent until the project needs it. Register a
family when it becomes real; never add `missing` placeholders for optional
state.

| Family | Location | Owner | Use |
|---|---|---|---|
| Project configuration | `.locus/config.toml` | `$locus-setup` / human | Repo-local Locus paths, defaults, and policy. |
| Project direction | `.locus/soul.md`, `.locus/goal.md`, configured roadmap | `$locus-owner` / `$locus-pm` / human | Identity, outcome, accepted direction, and priorities. |
| Working memory | `.locus/notes.md`, `.locus/concerns.md`, `.locus/plan.md` | `$notes` / human | Reminders, follow-up concerns, and parked ideas. |
| Prompts, recon, research | `.locus/prompts/`, `.locus/recon/`, `.locus/research/` | producing skill / human | Reusable prompt-shaped analysis, project maps, and research bundles. |
| Autonomous YOLO state | `.locus/yolo/` | `$locus-yolo` / human | Scored hypothesis ledger, contour journals, and companion contracts. |
| Generated state | `.locus/runtime/`, `.locus/docs-index.json`, other registered caches | owning CLI | Rebuildable machine state; never hand-edit or enumerate contents here. |

## Surface index (machine-readable)

This is the only per-project machine registry. Keep one row per major surface
or family, not one row per contained file. `repo-policy` paths may be absent;
`required-tracked` paths must survive a fresh clone.

<!-- locus:surface-index:v1:begin -->
| id | path_ref | owner | kind | purpose | authority | privacy | git_policy | derived_from | update_trigger | regenerate_with |
|---|---|---|---|---|---|---|---|---|---|---|
| locus.agents | .locus/AGENTS.md | $locus-docs | registry | routing map and surface registry for .locus/** | source | private | repo-policy | - | major .locus surface added, removed, or renamed | - |
| locus.config | .locus/config.toml | $locus-setup | config | repo-local Locus runtime policy | source | private | repo-policy | - | repo-level Locus policy changes | locus init |
| feature.specs | specs_root | $locus-spec | feature-specs | configured feature/change spec location | pattern-only | public | repo-policy | - | accepted spec changes | locus spec sync-index |
| docs.decisions | locus.docs.roots.adr | $locus-docs | adr-ledger | configured ADR / decision-doc location | pattern-only | public | repo-policy | - | durable architecture decision accepted | locus docs paths --stamp |
<!-- locus:surface-index:v1:end -->

## Maintenance rules

- Update this file only when a major `.locus/**` surface or its owner changes.
- Put documentation-family navigation in the docs root, not here.
- Search inside a registered directory when individual files are needed.
- Keep histories and generated indexes, and per-file status outside
  this auto-loaded file.

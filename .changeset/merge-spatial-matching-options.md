---
"@ifc-lite/export": minor
"@ifc-lite/cli": minor
---

feat(export): configurable spatial merge matching in `MergedExporter`

`MergedExporter` unifies `IfcSite`/`IfcBuilding`/`IfcBuildingStorey` across
merged models with a single fixed heuristic today. It now accepts explicit
matching strategies, mirroring IfcOpenShell/BlenderBIM's "Merge Projects"
recipe:

- `mergeSites?: 'single' | 'by-name'` — `'single'` ignores Name and unifies
  iff each model contributes exactly one `IfcSite`; `'by-name'` matches only
  same-name (case-insensitive) sites, with no single-instance fallback.
- `mergeBuildings?: 'single' | 'by-name'` — same strategy, for `IfcBuilding`.
- `mergeStoreys?: 'by-name' | 'by-elevation' | 'by-name-then-elevation'` —
  `'by-name'`/`'by-elevation'` match on exactly one criterion with no
  fallback; `'by-name-then-elevation'` is the pre-existing combined heuristic
  made explicit.

All three options are optional and, when omitted, preserve today's exact
default behavior (name match, else single-instance fallback for site/building;
name-then-elevation for storeys) — purely additive, no default behavior change.

The CLI `merge` command gains matching `--merge-sites` / `--merge-buildings` /
`--merge-storeys` flags.

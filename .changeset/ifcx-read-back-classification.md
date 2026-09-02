---
'@ifc-lite/ifcx': minor
---

`extractProperties` (the `PropertyTable` a `.ifcx` file resolves through, `packages/ifcx/src/property-extractor.ts`) no longer silently drops `ifclite::classifications`. The blanket `ifclite::*` skip added for #1031's internal carriers (deletion/derived markers, collab materials/geometryRef/provenance) also caught this key, but — unlike `bsi::ifc::material`, which has a real v5a schema attribute to unpack — there is no `bsi::ifc::classification` in the spec to fall back to, so a classification written under `ifclite::classifications` (as `@ifc-lite/export`'s `Ifc5Exporter` now does, #3608) was write-only: present in the file, invisible to every reader of `parsed.properties`.

Each classification ref (`{ system, code, uri?, description? }`) now unpacks into a `Classification - <system>` pset (`Code`/`Uri`/`Description` properties), the same way `bsi::ifc::material` already unpacks into a `Material` pset. A ref with no `code` carries nothing to show and is skipped, matching how a codeless material is already handled. Every other `ifclite::*` key is still skipped as before.

Refs are grouped by system before naming their pset, so a system that carries more than one ref (ordinary Uniclass practice: an element classified under both a Systems and a Products code, e.g. `Ss_25_10_30` and `Pr_20_93_47` both under "Uniclass 2015") does not collapse into a single pset that keeps only the last ref's `Code` paired with the first ref's `Uri`. The common single-ref-per-system case still reads as the plain `Classification - <system>`; a system with multiple refs disambiguates each into its own `Classification - <system> - <code>` pset so every ref keeps its own `Code`/`Uri` pairing.

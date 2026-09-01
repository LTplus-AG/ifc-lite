---
'@ifc-lite/ifcx': minor
---

`extractProperties` (the `PropertyTable` a `.ifcx` file resolves through, `packages/ifcx/src/property-extractor.ts`) no longer silently drops `ifclite::classifications`. The blanket `ifclite::*` skip added for #1031's internal carriers (deletion/derived markers, collab materials/geometryRef/provenance) also caught this key, but — unlike `bsi::ifc::material`, which has a real v5a schema attribute to unpack — there is no `bsi::ifc::classification` in the spec to fall back to, so a classification written under `ifclite::classifications` (as `@ifc-lite/export`'s `Ifc5Exporter` now does, #3608) was write-only: present in the file, invisible to every reader of `parsed.properties`.

Each classification ref (`{ system, code, uri?, description? }`) now unpacks into a `Classification - <system>` pset (`Code`/`Uri`/`Description` properties), the same way `bsi::ifc::material` already unpacks into a `Material` pset. A ref with no `code` carries nothing to show and is skipped, matching how a codeless material is already handled. Every other `ifclite::*` key is still skipped as before.

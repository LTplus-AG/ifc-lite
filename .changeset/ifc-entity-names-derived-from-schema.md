---
'@ifc-lite/data': patch
---

`IFC_ENTITY_NAMES` now names 282 entities it silently omitted, including `IfcWallElementedCase`, `IfcSlabElementedCase`, `IfcBuildingElement`, `IfcDoorStyle`, `IfcWindowStyle` and the whole `*StandardCase` family.

The map was a hand-maintained literal of 880 entries whose header named a regenerator, `scripts/generate-entity-names.ts`, that has never existed in this repository. The only thing pinning it was a test comparing it against `IfcTypeEnum`, a 128-member subset of the schema, so the other 1000-odd names could go missing unnoticed — and 282 had. Every caller doing `IFC_ENTITY_NAMES[upper] ?? upper` fell through to the raw UPPERCASE STEP keyword for those, so `IFCWALLELEMENTEDCASE` displayed as `IFCWALLELEMENTEDCASE` instead of `IfcWallElementedCase` in the CLI's info/diff output, the MCP query/diff/validation/discovery tools, the parquet export and the viewer's retype path.

The map is now built at load from `ifc-schema/generated/entities-{ifc2x3,ifc4,ifc4x3}.ts`, which `pnpm --filter @ifc-lite/data run generate:ifc-schema` regenerates from the buildingSMART schema dumps, so a schema bump carries the names along and there is no second list to fall behind. `IfcSolidStratum`, `IfcVoidStratum` and `IfcWaterStratum` are reachable through `IfcTypeEnum` but absent from those dumps, so they stay listed by name. A new both-directions test derives the same expectation independently and pins a named list of required entities, so a derivation that starts dropping or inventing names fails loudly.

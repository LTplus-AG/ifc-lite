---
"@ifc-lite/geometry": major
"@ifc-lite/parser": major
"@ifc-lite/data": major
"@ifc-lite/wasm": major
"@ifc-lite/extensions": minor
---

Remove unused public exports that had zero consumers anywhere in the monorepo (coordinated breaking change). Each was verified against internal code, the other apps, the examples, the scaffolding templates, and the docs before removal.

- **@ifc-lite/geometry**: drop `LODGenerator` / `LODConfig` / `LODMesh` (`lod.ts`), `DEFAULT_MATERIALS` / `getDefaultColor` / `getDefaultMaterialColor` / `MaterialColor` (`default-materials.ts`), and `calculateDynamicBatchSize`.
- **@ifc-lite/parser**: drop `StyleExtractor` (and its `IFCMaterial` / `StyleMapping` types) and `OpfsSourceBuffer`.
- **@ifc-lite/data**: drop `isBuildingLikeSpatialTypeName` — the enum-based `isBuildingLikeSpatialType` and the other spatial-type predicates stay.
- **@ifc-lite/extensions**: drop `slugify` and `suggestedExtensionId`; the sibling id helpers (`suggestedCommandId`, `flavorImportedId`, `flavorMergedId`, `DEFAULT_FLAVOR_ID`) are retained.
- **@ifc-lite/wasm**: drop the debug-only `debugProcessEntity953` / `debugProcessFirstWall` methods and the never-wired `scanEntityIndexShard` (Path C sharded-scan) export.

Also removes the dead `ifc-lite-engine` crate (no workspace dependents) and the no-op `serde` feature on `ifc-lite-core` (it gated no code).

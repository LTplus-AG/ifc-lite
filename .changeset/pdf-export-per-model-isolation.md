---
"@ifc-lite/viewer": patch
---

Fix the to-scale 3D-view PDF export printing geometry a federated (multi-model) session had hidden or isolated with the per-model "Isolate in 3D" action.

`view-pdf-export-source.ts`'s `gatherDrawnMeshes` folded `hiddenEntities`, `isolatedEntities`, `computedIsolatedIds` (storey/class isolation) and `typeVisibility`, but never read `hiddenEntitiesByModel` / `isolatedEntitiesByModel` — the per-model channel `basketVisibleSet.ts`'s `getVisibleGlobalIds` already applies as an independent, per-model AND. With two or more models loaded and a model-scoped hide or isolate active, the PDF export included that model's geometry even though the viewport did not draw it.

The channel is now applied per model, in that model's own local express-id space (converted from the mesh's global id via `idOffset`, mirroring `getVisibleGlobalIds`), before meshes are handed to `collectViewMeshes`. `ghostExceptEntities` (X-Ray translucency) remains untouched — a ghosted-but-visible entity still exports, matching the sibling `resolveExportVisibility()` (#4333) ruling.

---
'@ifc-lite/viewer-embed': patch
---

Render the Model view in the embed, not the type library on top of it.

`EmbedViewer`'s mesh filter gated on `hideTypes` and three `typeVisibility` toggles and applied no `geometryClass` gate at all, so every instanced type copy (class 2) was drawn along with the building it duplicates. Those copies sit at the type's `MappingOrigin` rather than at any occurrence's placement, so on `AC20-FZK-Haus.ifc` they show as an upside-down roof plane and a floating slab, and picking either returns `IfcSlabType` or `IfcWallType` — a type definition, not an element. Orphan type geometry (class 1) was drawn the same way: a model carrying unplaced `IfcXxxType` definitions laid them over the real one.

The full viewer has never had this because it routes the same mesh list through `selectModelMeshes` (`apps/viewer/src/lib/type-view-visibility.ts`), which is the one predicate for "which meshes are the building" (#957, #1353). The embed now calls it too, imported across through the `@` alias it already uses for the store, `Viewport` and `useIfc`, rather than restating the rule in a second place that can drift. A pure type-library file (buildingSMART annex-E, zero placed occurrences) still renders its orphan types, because that predicate keeps class 1 when nothing is placed — hiding it there would blank the screen instead of fixing anything. That test is over the whole loaded set, not per model: federate a type-library file alongside a building with `addModel` and the building's occurrences make the type file's orphans read as type-library content, so they are not drawn. The full viewer resolves it the same way and offers the Types view as the way to see them; the embed has no such switch.

No new protocol field: the embed renders the Model view, fixed. Nothing else changes about what a host can hide.

---
'@ifc-lite/export': patch
---

Fix `StepExporter` emitting a dangling `IFCRELDEFINESBYPROPERTIES` when a property or quantity is edited on an entity that is then deleted (#1978).

The entity-emission loop already skips a tombstoned entity's own line, but `newPropertySets` / `newQuantitySets` / `typeOwnedPsetNamesByEntity` are built from `getMutations()`, which returns unfiltered history and does not consult tombstones (the same root cause as #1957). Without a guard, the pset/qset generation loops still ran for the deleted entity and wrote an `IFCRELDEFINESBYPROPERTIES` referencing a `#N` with no defining line — a dangling reference, i.e. structurally invalid IFC rather than merely a dropped edit.

All three consumers of those collections (new property sets, new quantity sets, and type-owned pset rewrites left over after deletion) now check `isDeleted` the same way the entity-emission loop does before emitting anything.

This also closes an adjacent hole in the same shape: an overlay-created entity (`createEntity`) that has a property or quantity edit and is then deleted. `deleteEntity` forgets a newly-created entity instead of tombstoning it, so `isDeleted` returns false for it and the guard above didn't catch it. The three consumers now check whether the entity will actually appear in the output at all — either as a still-present source entity or as a still-live overlay-created entity — rather than only whether it was tombstoned.

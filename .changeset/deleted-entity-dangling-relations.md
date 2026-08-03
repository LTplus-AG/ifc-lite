---
'@ifc-lite/export': patch
---

Fix `StepExporter` emitting a dangling `IFCRELDEFINESBYPROPERTIES` (or a type entity's rewritten `HasPropertySets`) that references an entity with no defining line in the output.

Editing a property or quantity on an entity, then making that entity disappear from the export by any of three routes, used to leave the reference behind:

- **Deleting the entity.** The entity-emission loop already skipped a deleted entity's own line, but the pset/qset generation loops didn't consult tombstones, so they still emitted a relation pointing at nothing.
- **Creating an entity in the overlay, then deleting it.** `deleteEntity` forgets a newly-created entity instead of tombstoning it, so a tombstone check alone can't catch this case — the entity was never tombstoned, it just no longer exists.
- **Hiding the entity under a `visibleOnly` export.** The visibility filter drops the entity's own line, but the pset/qset generation loops ignored the visible-entity closure entirely.

All four places that generate a property or quantity set entity, or rewrite a type entity's `HasPropertySets` attribute, now share one check — "will this entity id have a defining line in the output at all" — instead of three separate special cases that each covered only one route.

This makes the export internally consistent: it no longer writes a relation with a dangling reference. It does not make a hidden or deleted entity's edits survive export, and an entity created in the overlay and then hidden under `visibleOnly` is still dropped from the output (a separate, pre-existing gap).

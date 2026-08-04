---
"@ifc-lite/export": patch
---

Stop `ParquetExporter` from exporting entities deleted via `MutablePropertyView.deleteEntity()` (#2046).

`ParquetExporter`'s table writers clone whole typed-array columns straight out of `IfcDataStore` — `Entities`, `Properties`, `Quantities`, `Relationships`, and the derived `SpatialHierarchy` — with no per-entity loop and, until now, no `MutablePropertyView` parameter to consult at all. An entity deleted via the overlay was exported anyway, and so were its properties, quantities, and relationship edges. `StepExporter`/`Ifc5Exporter` already resolved the same class of bug via `getEffectiveEntityIndex(...).isDeleted()` (#2036, #2047).

`ParquetExporter` now takes an optional `mutationView` as its third constructor argument — existing `new ParquetExporter(store)` callers (the README example, `tests/integration.test.ts`) are unaffected. When supplied, a deleted entity's own row is dropped from `Entities`, and every `Properties`/`Quantities`/`SpatialHierarchy` row keyed by that entity and every `Relationships` edge touching it are dropped too. This is deletion-only, and only for the entity actually deleted: unlike `StepExporter`/`Ifc5Exporter`, the column-copy shape here has no per-entity emission pass to also apply the overlay's pset/quantity/attribute *edits*, so those still export the source values verbatim; and `SpatialHierarchy` is a source-parse snapshot with no overlay-aware re-parenting, so a deleted storey/building/site can still surface as a surviving element's `StoreyId`/`BuildingId`/`SiteId` (the class of problem `Ifc5Exporter`'s re-parenting pass solved in #2047, not addressed here). Call out to `StepExporter`/`Ifc5Exporter` for full overlay-aware export in the meantime.

No shipped surface (viewer, CLI, MCP) constructs `ParquetExporter` today, so this closes the exporter-side gap without a call-site change; a future consumer can now pass its `MutablePropertyView` and get correct output from the start.

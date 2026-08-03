---
"@ifc-lite/export": patch
---

Stop `Ifc5Exporter` (IFC5/IFCX) from exporting entities deleted via `MutablePropertyView.deleteEntity()` (#2046).

`Ifc5Exporter` walked `dataStore.entities` directly and never consulted the overlay's tombstone state, so a deleted entity still came out in the IFCX output — both as its own node and, in some cases, as a child reference of a still-exported spatial container. `StepExporter` already resolved this via `getEffectiveEntityIndex(...).isDeleted()` (#2036); `Ifc5Exporter` now builds the same `EffectiveEntityIndex` once per export and gates the node-collection loop, the UUID-assignment pass, and the child-name/grouping passes on it, so a deleted entity is absent from the output entirely rather than surviving as a dangling child path.

`ParquetExporter` has the same gap plus a wider one (no `MutablePropertyView` parameter at all) and is intentionally out of scope here — tracked separately in #2046.

Follow-up (#2047): deleting a still-non-empty spatial container (e.g. a storey) left its surviving contents (e.g. a wall) present in `file.data` but unreachable from the document root — the deleted container was skipped when the exporter asked "what are this node's children", so nothing ever listed the wall as a child. `Ifc5Exporter` now re-parents a surviving child to its nearest surviving ancestor when its direct parent is deleted, walking up the hierarchy (falling back to the document root if every ancestor up to the root is also deleted), and this re-parented map is now the single source the exporter consults for the emitted `children` tree. The ancestor walk is bounded against cycles in the source hierarchy.

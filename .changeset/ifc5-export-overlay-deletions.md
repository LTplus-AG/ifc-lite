---
"@ifc-lite/export": patch
---

Stop `Ifc5Exporter` (IFC5/IFCX) from exporting entities deleted via `MutablePropertyView.deleteEntity()` (#2046).

`Ifc5Exporter` walked `dataStore.entities` directly and never consulted the overlay's tombstone state, so a deleted entity still came out in the IFCX output — both as its own node and, in some cases, as a child reference of a still-exported spatial container. `StepExporter` already resolved this via `getEffectiveEntityIndex(...).isDeleted()` (#2036); `Ifc5Exporter` now builds the same `EffectiveEntityIndex` once per export and gates the node-collection loop, the UUID-assignment pass, and the child-name/grouping passes on it, so a deleted entity is absent from the output entirely rather than surviving as a dangling child path.

`ParquetExporter` has the same gap plus a wider one (no `MutablePropertyView` parameter at all) and is intentionally out of scope here — tracked separately in #2046.

---
"@ifc-lite/export": patch
---

Fix STEP exporters dropping deferred property atoms, which produced hundreds of thousands of dangling `#`-references in merged (and single-model) IFC output.

On large files the parser can move high-cardinality property atoms (`IfcPropertySingleValue`, `IfcQuantity*`, `IfcPropertyEnumeratedValue`, …) out of `entityIndex.byId` into a secondary `deferredEntityIndex` to cap memory (`deferPropertyAtomIndex`). Every other consumer (on-demand property/material extraction) reads through the `byId.get(id) ?? deferredEntityIndex.get(id)` fallback, but `MergedExporter` and `StepExporter` walked `byId` alone. They therefore emitted the `IfcPropertySet` / `IfcElementQuantity` *containers* while silently dropping the atoms those containers reference — leaving the STEP output full of references to entities that are never defined. Strict viewers (e.g. BIM Vision) reject such files, and lenient ones fall geometry back to the origin when a placement / type / material chain resolves to a dropped entity.

Both exporters now iterate the complete entity set via a shared `getCompleteEntityIndex` helper (primary index + deferred atoms), and the merge offset / new-id allocation now spans deferred ids too so remapped ids can't collide with a deferred atom sitting at a higher express id. When nothing was deferred the primary index is returned unchanged, so the common path keeps its existing behaviour and cost.

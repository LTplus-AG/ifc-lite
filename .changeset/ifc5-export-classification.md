---
'@ifc-lite/export': minor
---

`Ifc5Exporter.export()` (STEP → IFCX/IFC5) no longer drops an entity's `IfcClassificationReference`s. Every other source attribute the exporter carries — class, name, description, properties, mesh — had a path into the IFCX output; classification (`IfcClassificationReference` via `IfcRelAssociatesClassification`, including type-level associations) had none, so a classified wall exported to IFCX silently lost its classification with no warning anywhere in the pipeline.

Classified entities now carry an `ifclite::classifications` attribute (`{ system, code, uri?, description? }[]`), the same key and shape `@ifc-lite/collab`'s snapshot layer already uses for its structured classification branch. Paired with the companion `@ifc-lite/ifcx` change in this release (which stops skipping that key on read), the classification now survives a re-import through `parseIfcx` too, not just through the collab layer. An entity with no classification is unaffected — no attribute is added.

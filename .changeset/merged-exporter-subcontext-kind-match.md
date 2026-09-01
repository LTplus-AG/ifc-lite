---
'@ifc-lite/export': patch
---

`MergedExporter` no longer unifies a model's `IfcGeometricRepresentationSubContext` (`'Body'`, `'Axis'`, …) onto the primary model's by array position. Two exporters don't guarantee the same subcontext emission order, so a positionally-matched second model's `'Body'` subcontext could get unified onto the primary model's `'Axis'` subcontext (or vice versa): every `IfcShapeRepresentation.ContextOfItems` that pointed at the dropped subcontext now resolved to a surviving one of the wrong kind, which many viewers filter out of the 3D view entirely — geometry silently vanishing, with no dangling reference to reveal it. Subcontexts are now matched by kind (`ContextIdentifier`, falling back to `TargetView`) before being deduplicated; a subcontext with no same-kind match in the primary model keeps its own (offset-only) copy instead of being merged onto an unrelated one.

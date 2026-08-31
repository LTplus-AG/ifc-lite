---
'@ifc-lite/export': patch
---

`MergedExporter` now preserves a model's representation context when its resolved `WorldCoordinateSystem` frame differs from the primary model's, preventing untouched coordinates from being interpreted in the wrong origin or orientation. For matching frames, it deduplicates each `IfcGeometricRepresentationSubContext` by its `ContextIdentifier`, `TargetView`, and (for `USERDEFINED`) `UserDefinedTargetView`, rather than source-array position. An unmatched subcontext remains in the output, keeping its `IfcShapeRepresentation.ContextOfItems` reference intact.

---
"@ifc-lite/wasm": patch
---

`parseAlignmentLines` also finds IFC4x3 alignments: the centerline is read from the `'Axis'` (else `'FootPrint'`) shape representation — `IfcGradientCurve`, `IfcSegmentedReferenceCurve` or `IfcCompositeCurve` — and the alignment's `ObjectPlacement` is applied. Previously only IFC4x1 `Axis` attributes were recognised, so no IFC4x3 alignment line was drawn. The lookup lives in one canonical `locate_axis_curve`, shared with the alignment processor.

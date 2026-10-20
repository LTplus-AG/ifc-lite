---
'@ifc-lite/wasm': patch
---

`IfcLinearPlacement` and `IfcAlignment.Axis` are read at the positions of the schema the file declares. On IFC4X1 and IFC4X2 files an authored `CartesianPosition` (attribute 3 / 4) is now honoured, so products placed linearly are placed instead of piling at the origin, and the analytic export no longer refuses their placement chain. On IFC4X3 files the alignment directrix is no longer taken from attribute 7, which there is `PredefinedType`.

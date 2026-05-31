---
"@ifc-lite/wasm": patch
---

Centre parameterised profiles on their bounding box.

`IfcUShapeProfileDef`, `IfcLShapeProfileDef` and `IfcTShapeProfileDef` were
generated from a corner instead of centred on their bounding box, so channels were
offset by half the flange width, angles by half their leg lengths and tees by half
their depth. The base profile is now centred before the swept-area `Position`
placement is applied, matching the symmetric profiles (I-shape, rectangle, …) and
the IfcOpenShell/Tekla/Revit convention.

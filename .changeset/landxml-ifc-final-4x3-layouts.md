---
"@ifc-lite/create": patch
---

Fix two IFC4X3 schema-conformance defects in LandXML→IFC output (#4937). `IfcTriangulatedIrregularNetwork` wrote `Normals` before `Closed`, so the mandatory `.F.` landed in `Normals`. `IfcMapConversion` wrote 8 attributes where final IFC4X3 has 10 (`ScaleY`, `ScaleZ`). Both followed the pre-release IFC4X3 draft in `packages/codegen` rather than ISO 16739-1:2024. `ifcopenshell.validate` rejected both, and it now checks this output in CI.

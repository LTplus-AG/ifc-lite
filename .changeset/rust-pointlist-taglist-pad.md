---
"@ifc-lite/wasm": patch
---

The native (Rust) STEP converter now pads `IfcCartesianPointList2D` / `IfcCartesianPointList3D` with the optional `TagList` that IFC4X3 appends, matching the TypeScript converter (#5755). IFC4 → IFC4X3 conversion (`exportStep`, `export_merged`, the CLI) wrote these one attribute short, which `ifcopenshell.validate` rejects. It hit every IFC4 model with tessellated geometry: 26 issues (two per point list) on a two-model merge of buildingSMART samples, now 0.

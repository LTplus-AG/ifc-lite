---
"@ifc-lite/geometry": patch
"@ifc-lite/wasm": patch
---

Render `IfcSurfaceCurveSweptAreaSolid` and `IfcFixedReferenceSweptAreaSolid` solids. Round HVAC duct elbows — a circular profile swept along a trimmed circular-arc directrix, how Revit exports IFC4.3 duct bends — had no geometry processor registered and were silently dropped from the model. They now mesh as swept tubes (a rotation-minimising frame carries the section along the directrix, exact for the circular cross-sections these fittings use). Fixes #1485.

---
"@ifc-lite/drawing-2d": minor
---

Export Distance markup as linework and text on the IFC-DIMENSIONS DXF layer, through the drawing coordinate transform. The viewer now includes placed Distance measurements in DXF downloads. The exported `isDxfDimensionExportable` predicate shares the writer’s validity rule with download omission warnings, including zero-length measurements.

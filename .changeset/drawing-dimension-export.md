---
"@ifc-lite/drawing-2d": minor
"@ifc-lite/viewer": patch
---

Drawing exports now include linear dimensions. The 2D drawing panel's SVG (direct and sheet, and so print and the sheet PDF), DXF and vector PDF exports draw each dimension on the cut now shown with the same geometry as the canvas: dimension and extension lines, architectural 45° ticks and a 2.5 mm value (on paper, at the export scale), upright in every section direction. DXF puts them on an `IFC-DIMENSIONS` layer. Dimensions drawn on another cut are left out of every export, and the PDF and DXF notices now say so; dimensions on the current cut no longer count as omitted markup.

`exportToDXF` takes a new `textLayers` option (`DXFTextLayer`, `DXFText`): single-line TEXT on named layers, positioned in drawing space through `coordinateTransform`, with the angle measured after it and an optional `keepUpright`.

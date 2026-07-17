---
"@ifc-lite/drawing-2d": minor
---

Add DXF import as a 2D reference underlay (#1782): `importDxf` parses ASCII DXF (LINE, LWPOLYLINE/POLYLINE with bulges, CIRCLE, ARC, ELLIPSE, SPLINE, SOLID/TRACE, HATCH, TEXT/MTEXT, DIMENSION blocks, INSERT/BLOCK with nested transforms) into world-plan geometry (metres, +Y = north) with per-layer visibility, ACI/true-colour and lineweight resolution, $INSUNITS scaling, and a unitless-file millimetre heuristic. `SVGExporter` gains an `underlays` option to composite DXF reference layers beneath exported drawings, and `applyDxfPlacement` positions underlays (offset/rotation/scale) in drawing space.

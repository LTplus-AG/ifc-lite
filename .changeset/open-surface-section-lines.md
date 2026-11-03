---
"@ifc-lite/drawing-2d": minor
---

Sections through open surfaces (such as an `IfcShellBasedSurfaceModel` with an `IfcOpenShell`) now produce cut lines instead of filled `cutPolygons`. Open chains on an entity whose mesh has free edges no longer get closed by an invented chord; those segments carry the new `DrawingLine.openSurfaceCut` flag so renderers draw them (`isPolygonCutLine` tells them apart from polygon-covered cut lines), and `SectionCutter`/`cutMeshesStreaming` results report them as `openSurfaceSegments`. Solids keep their fill, including ones with hairline mesh cracks.

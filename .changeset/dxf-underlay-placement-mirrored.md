---
'@ifc-lite/drawing-2d': patch
---

Fix `DXFExporter`'s `underlays` option applying a `DxfPlacement`'s offset/rotation with the opposite sign from every other consumer of the same type.

`DxfPlacement` is documented as drawing space (+Y down): "Offset in metres (drawing space)", "counter-clockwise as seen on a plan view". `svg-exporter.ts`'s underlay mapping and the viewer's `dxfUnderlayMath.ts` (`worldToDrawing`, driving the 2D canvas and the 3D reference overlay) both negate Y before calling `applyDxfPlacement`, then negate back for a world-space output — so the same placement value produces the same visual result everywhere. `dxf-exporter.ts`'s `writeUnderlay` called `applyDxfPlacement` directly on world-space (+Y up) points, skipping that round trip: a placed underlay with a non-zero `offsetY` shifted north instead of south, and a non-zero `rotationDeg` spun clockwise instead of counter-clockwise — a silently mirrored underlay in the exported DXF, diverging from what the SVG export and the viewer itself show for the identical placement.

Not reachable through the current viewer UI — its DXF export explicitly does not embed underlays yet (see `useDrawingExport.ts`'s `handleExportDXF`) — but `DXFExporter.export`'s `underlays` option is documented and exercised by the package's own README example and test suite, and is public API for any direct consumer of `@ifc-lite/drawing-2d`.

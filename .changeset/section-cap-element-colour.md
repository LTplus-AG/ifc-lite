---
'@ifc-lite/renderer': minor
'@ifc-lite/drawing-2d': minor
---

Section caps can fill with each element's own colour: `DrawingPolygon.sourceColor` now carries the source sub-mesh colour on every cut polygon that has one, and the cap style gains an optional `fillMode` preference (`'element'`/`'uniform'`) for the app to turn that into per-polygon cap colours (the renderer draws whatever polygon colours it is given). Also, a selected or hovered element's cap polygons are drawn in the highlight colour via the new `RenderOptions.capHighlight`.

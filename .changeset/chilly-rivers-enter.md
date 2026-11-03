---
"@ifc-lite/drawing-2d": major
---

Release the open-surface section result contract as a major version. `SectionCutResult` now requires `openSurfaceSegments`; callers constructing results must provide that set. Consumers of `polygons` must also handle open-surface segments, which no longer produce an artificial closing polygon. Use `openSurfaceSegments` for those cuts and `isPolygonCutLine` when deciding which drawing lines a polygon already covers.

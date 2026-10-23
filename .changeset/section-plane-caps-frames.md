---
"@ifc-lite/renderer": minor
---

Several cutting planes, part two (#7545). A cap per plane: `uploadSection2DOverlay(…, planeId)` keys the cap of a plane in `extraSectionPlanes` (`clearSection2DOverlay(planeId)`, `clearSection2DExtraOverlays(keep)`), and every cap and its outline is discarded where another plane removes it. `Renderer.getSectionPlaneFrames()` reports each plane's world-space anchor and rectangle for labels and handles, `SectionPlane.showGizmo = false` hides only the primary preview quad, and `Camera.frameBounds` takes an optional padding multiple so a view can be framed with an exact margin.

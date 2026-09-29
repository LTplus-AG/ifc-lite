---
"@ifc-lite/renderer": minor
---

Add opt-in exact source-curve magnetic snapping through `Renderer.setSourceSnapCurves`. Returned `SnapTarget.metadata.sourceCurve` identifies the authored segment and its exact length while screen-space picking evaluates lines and signed arcs without using display chords.

---
"@ifc-lite/drawing-2d": patch
---

Section cut rings now also drop tessellation split points on sloped faces of elements stored far from the model origin without a per-element origin. The collinear-vertex tolerance is floored at the float32 rounding noise of the element's coordinates (about 24 µm at 100 m), which stays far below real corners, short chamfers and arc tessellation.

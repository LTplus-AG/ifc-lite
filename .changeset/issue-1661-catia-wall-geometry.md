---
"@ifc-lite/wasm": patch
---

CATIA walls no longer disappear (issue #1661). Two geometry fixes: (1) representations whose `RepresentationType` is an empty string now fall back to the `RepresentationIdentifier` for body filtering - CATIA writes `IFCSHAPEREPRESENTATION(#ctx,'Body','',(items))`, and the empty type vetoed the entire representation, meshing the element to zero triangles. (2) Advanced-face edge loops now sample every curved edge-geometry type (trimmed curves over circle/ellipse/B-spline bases, rational B-splines, ellipses, composite curves, polylines) instead of collapsing them to a single vertex, and the B-spline edge sampler reads KnotMultiplicities/Knots at their schema positions (an off-by-one meant real-file B-spline edges never sampled).

---
"@ifc-lite/create": patch
---

Dedup coincident footprint points before deriving a wall's centreline axis. The
body-footprint fallback (`principalAxisCentreline`, used for walls with no `Axis`
representation) took the PCA of the raw projected vertices, whose **centroid** is
pulled off the true wall mid by redundant points — a closed profile polyline
repeats its first point, and a mesh projects many shared vertices onto the same
XY. That left the derived axis (and so the room corners built on it) a couple of
cm off the wall centreline. Deduping coincident points (within 0.1 mm) gives an
unbiased centroid, so the axis sits on the true wall mid and room corners land on
the exact wall axis.

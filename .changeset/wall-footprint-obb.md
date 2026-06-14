---
"@ifc-lite/create": minor
---

`extractWallSegmentsForStorey` now also returns `obbs` — each wall's footprint
**rectangle** (4 CCW corners, metres), computed from the body footprint's PCA
axis directions and min/max extents (so it's invariant to vertex distribution,
unlike the centroid). The rectangle's two long edges are the wall's faces, which
is the face-accurate input the face-based room derivation needs (rooms = the gaps
between wall rectangles; the room boundary is the wall inner faces). `undefined`
for walls with no body footprint (axis-rep / rect-profile / overlay).

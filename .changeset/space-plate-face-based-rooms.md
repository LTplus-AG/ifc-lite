---
"@ifc-lite/wasm": minor
---

`SpacePlateHandle` gains a face-based room derivation: `fromWallRects(rectCoords,
snapTolerance, minArea)` builds a plate from each wall's footprint **rectangle**
(4 corners, wall-major) instead of its centreline. Rooms are the bounded **gaps
between** the rectangles — a face is a room iff its centroid falls outside every
wall rectangle — so the room boundary is the wall faces themselves and every node
lands on the true wall axis (no PCA-centroid distribution bias).

`gapBoundary(face, factor)` reads a room's outline offset outward per edge by
`factor · ½ thickness`: `0` = net (inner faces), `1` = the wall axis (centreline),
`2` = gross (outer faces). This replaces the centreline+net-offset approach for
derived plates; centreline plates (`new SpacePlateHandle(...)`) are unchanged.

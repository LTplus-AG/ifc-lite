---
"@ifc-lite/wasm": minor
---

Add two interactive editing operations to `SpacePlateHandle` (the persistent space-topology editor):

- `dissolveVertex(v)` — dissolve a degree-2 vertex, welding its two incident edges into one straight edge between the neighbours (the inverse of `splitEdge`). Rejects wall junctions (degree ≥ 3) and welds that would duplicate an edge.
- `addFace(coords, source)` — author a new room face from a flat ring `[x0, y0, x1, y1, …]`; winding is normalised to CCW and the room becomes its own connected component. Rejects rings that are too short, self-intersecting, or near-zero area.

Backed by new `dissolve_vertex` / `add_face` operations in the `ifc-lite-geometry` `space_dcel` core.

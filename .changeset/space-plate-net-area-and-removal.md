---
"@ifc-lite/wasm": minor
---

Extend `SpacePlateHandle` (the persistent space-topology editor) with orphan
removal and engine-computed wall-boundary outlines:

- `removeEdge(edge)` — remove a wall, choosing the right semantics from its two
  faces: union two real rooms, or delete a bridge/spur wall and auto-clean the
  orphaned inner lines + nodes it leaves; a real enclosing wall is refused.
- `prune()` — sweep the plate clean (dangling spur walls, isolated nodes,
  redundant collinear nodes); returns how many elements were pruned. Build also
  auto-prunes so derived plates start as just their rooms.
- `netOutline(face, inset)` — the room outline offset to the net (inner) or
  gross (outer) wall face, using each edge's own wall half-thickness with
  topology-aware shared-edge pinning (no fuzzy edge↔wall matching).

The constructor now takes an additional `segHalfThickness: Float64Array`
(per-segment half-thickness in metres, carried onto the derived edges for
`netOutline`); pass an empty array when thickness is unknown.

It also takes a `segCentering: Float64Array` (`[dx, dy, …]`, two per segment) and
**slides each corner onto the wall's true geometric mid after building**. A wall
axis derived from a meshed/asymmetric footprint is its vertex centroid — pulled a
couple of cm off the wall mid — and `segCentering` carries the world offset to
the mid. The re-centring is a topology-preserving vertex relaxation (it
re-intersects the incident walls' mid-lines), so unlike shifting the input
segments it cannot collapse a room. Pass an empty array (or zeros) for
well-defined axes (axis-rep / rect-profile); those walls don't move.

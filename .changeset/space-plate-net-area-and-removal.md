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

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
  gross (outer) wall face. Every edge is offset by the room's **median** wall
  half-thickness (one representative thickness keeps the ring symmetric on models
  that mix 0.20 m partitions with 0.34 m load-bearing walls, instead of jutting
  out on the fat edge), with topology-aware shared-edge pinning and no fuzzy
  edge↔wall matching.

The constructor now takes an additional `segHalfThickness: Float64Array`
(per-segment half-thickness in metres, carried onto the derived edges for
`netOutline`); pass an empty array when thickness is unknown.

`build` also **regularizes the derived plate onto the model's own orthogonal
frame**: derived centrelines carry sub-degree skew (e.g. a PCA-of-footprint axis
tilted ~0.5°), so corners sat on the tilted axis rather than the true wall line.
A topology-preserving vertex snap straightens near-axial walls (collinear runs
collapse onto one grid line, corners land where walls truly cross) while leaving
genuinely-angled walls untouched — so rooms stay clean and a non-orthogonal
building is unaffected. It only moves vertex positions (never merges edges), so
it can't collapse a room.

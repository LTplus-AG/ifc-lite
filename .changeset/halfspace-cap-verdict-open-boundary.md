---
"@ifc-lite/geometry": patch
---

Fix `cap_half_space_clip` reporting `capped: true` while a boundary edge was left open.

The boundary chain walk dropped a dead-ended chain (no continuation back to
its start) and could also fold an unclosed chain into an already-visited
vertex, treating it as if it were a closed loop. Neither case affected
`outer_count`/`outer_filled`, the two counters the return value was computed
from, so an open edge from a dead-ended or merged chain never showed up in
the verdict.

On a non-watertight host — a routine input to
`BooleanClippingProcessor::clip_mesh_with_half_space` — this could report
`capped: true` with open boundary edges still present, contradicting the
function's own contract ("a boundary that does not close bails") and the
per-piece "was the cut closed" signal #1810 zone splitting depends on for a
trustworthy quoted volume.

The walk now tracks whether any chain failed to close, and that flag is
ANDed into the returned verdict alongside the existing counters.

The merge-into-an-already-visited-vertex arm had a second bug beyond the
verdict: it set the flag and `break`, matching the code comment ("do NOT
push it as if it were a closed loop"), but never cleared the partial walk
first, so the un-closed chain was still `>= 3` vertices long and got pushed
into `loops`, triangulated, and appended to the mesh — garbage cap geometry
landing in the output even on a call that correctly reported
`capped: false`. The merge arm now clears the partial walk before breaking,
matching its sibling dead-end arm.

Scope note: `capped` only measures whether the ON-PLANE cut section closed.
A host with pre-existing OPEN boundary edges off the cut plane still reports
`capped: true` — the boundary walk is filtered to on-plane endpoints by
design, so it never re-examines unrelated openness elsewhere on the mesh.

Also adds `kernel::mesh_volume`, a public, closedness-UNGATED divergence-
theorem volume reading for a `Mesh` (delegates to the crate's one
divergence-sum implementation, `signed_volume6`). It is a raw primitive, not
a replacement for `geom_closure::GeometryHasher::volume` — that one stays
the crate's closedness-gated, per-entity volume and requires the hasher's
accumulated state; `mesh_volume` is for a bare `Mesh` (e.g. a future
zone-split piece) that never went through it. Callers of `mesh_volume` must
establish closedness themselves first; see its doc for the exact
translation-stability guarantee (stable up to a documented quantization
noise floor, not exact).

---
"@ifc-lite/wasm": patch
---

Fix a void-cut tear on faceted-BREP window cutters with splayed/stepped reveals (the ara3d ISSUE_098 plan-rotated Poroton wall, and the same defect class on any wall whose openings are `IfcFacetedBrep` reveal prisms). The exact mesh-arrangement kernel left the cut non-watertight — jagged flap triangles bridging the openings.

Root cause: near-coplanar tri-tri intersections mis-record constraints whose interned points keep a cutter vertex's own 3D identity, sitting mm-to-cm off the face they constrain. Inserting them into that face's 2D CDT collapses two distinct 3D vertices onto one 2D location (when the segment runs along the drop axis) and pulls the face's sub-triangles off its plane, so the centroid inside/outside classification then keeps faces lying outside the host.

Two fixes: (1) `retriangulate::triangulate` now drops any constraint whose endpoints project to the same 2D point under the face's drop axis, or lie farther than 1 mm off the face's own plane — a genuine in-plane constraint always has 2D extent and sits on the plane within f32/snap noise (tens of µm), so none are dropped. (2) The disjoint-cutter batching gate welds the extended cutter to bit-exact closure before the `mesh_is_closed_exact` check, so a geometrically-watertight faceted cutter whose shared-edge f32 coords differ in bits after the placement transform can still join a batch (avoiding the sequential per-cut f32 re-jitter).

The splayed reveals are preserved (no box-cut approximation). The full pinned CSG corpus is unperturbed. Atomic box-minus-one-cutter goes from 28 to 0 unpaired edges; the 7-window wall from ~2534 to ~42 (5 of 7 windows fully watertight; the remaining two are a deeper batched multi-component classification residual, tracked separately).

---
"@ifc-lite/wasm": patch
---

Fix walls sticking through curved roof slabs on AC20-Institute-Var-2
(issue #583, PR #789). The chained-polygonal-bounded-half-space code
path used to mesh-merge every cutter in an `IfcBooleanClippingResult`
chain into one combined cutter before running a single BSP CSG
subtract. When the chain contained overlapping or duplicate prisms
(Wand-010 has four chained cutters including an exact duplicate at
`x = [17, 25]`), the merge of two closed solids occupying the same
volume was non-manifold by construction and BSP produced sliver
artefacts that left ~0.4-2.7 m of wall sticking through the roof.

The fix follows the web-ifc model: drop the batching, let chains fall
through the standard recursive single-cutter path. Each per-step
cutter is a single closed manifold prism, structurally eliminating
the non-manifold-cutter root cause. Two long-standing
`IfcPolygonalBoundedHalfSpace` issues that the batched path was
masking were also fixed: the prism now extrudes along the cutter
Position's `+Z` axis (per the IFC 4.3 spec, not the plane's material-
side direction), and the polygon winding is reversed against
`Position.Z` to match the cap reversal in `build_tilted_prism_mesh`.

---
"@ifc-lite/wasm": patch
---

Geometry correctness fixes from the calibration-report sweep (PR #655):

- **W410x60 / wide-flange profile area is now correct to within arc-sampling
  noise.** Revit authors I-beams as `IfcArbitraryClosedProfileDef` whose
  composite curve mixes long polyline edges with short fillet-arc edges;
  the over-tessellated-curve detector was misclassifying the mix as a smooth
  curve and RDP was slicing across the polyline corners, adding ~4.3 % to
  the swept volume. Now gated on a longest-edge/diagonal ratio so mixed-
  geometry profiles bypass simplification entirely.

- **Walls authored with `IfcExtrudedAreaSolid` profiles whose aspect ratio
  exceeds 100:1 no longer emit as hollow tubes.** The cap-skip threshold
  caught normal residential interior walls (115 mm × 12 m = ratio 103),
  dropping their top/bottom faces. Raised to 10000:1 — only genuinely
  pathological profiles trigger the skip now.

- **Opening extension no longer wipes the wall when the opening's
  extrusion axis maps to the wall's long axis.** Two new gates skip the
  extension heuristic when (a) the opening already spans the wall in the
  extrusion direction (advanced_model #553010, a 300 mm horizontal slot),
  and (b) the wall extends further along the extrusion direction than the
  opening's longest dimension (advanced_model #612315, a 115 mm column
  whose Position transform rotates +Z onto the wall's 11.8 m long axis).
  Six previously-failing calibration walls now produce correct cuts.

- **New `Mesh::welded()` and `Mesh::welded_by_position()` APIs** on the
  Rust mesh type for opt-in vertex deduplication. Default emission stays
  unwelded triangle soup so GPU consumers keep per-face flat normals;
  call sites that need a manifold mesh (volume queries, CSG, watertight
  checks) can opt in. Welding the duplex M_Fixed window drops vertex
  count from 180 → 48 (3.75×) and pushes manifold-edge fraction from
  32 % to 95 %. JS-side exposure is a separate follow-up.

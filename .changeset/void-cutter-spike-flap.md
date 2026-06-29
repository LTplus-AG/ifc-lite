---
"@ifc-lite/geometry": patch
"@ifc-lite/cache": patch
---

Fix two rendering defects from malformed self-intersecting tessellated void
cutters (window/door openings authored as `IfcPolygonalFaceSet` whose point list
carries garbage vertices metres from the real opening, plus a sibling multi-body
extruded cutter). The exact mesh-arrangement kernel mishandles such cutters two
ways, both fixed without touching the cut path:

- A far-flung "fin" triangle leaked into the host output as a multi-metre spike
  poking out of the wall, surfacing only under the multi-cutter arrangement (so
  it slipped past the per-cutter admission guards). A boolean subtract can only
  REMOVE material, so the result is contained in the host's pre-cut AABB; any
  output triangle reaching beyond it is provably an artifact and is now dropped
  (`Mesh::clip_triangles_to_aabb`, which also compacts the orphaned vertices so
  bounds/picking/clash/export stay correct).

- The same cutters made the kernel UNDER-cut, leaving a wall flap bridging the
  opening on the wall face. For each cutter detected as malformed (intrinsic
  vertex clustering, since a fin running along a long wall stays inside its
  AABB), the real opening box is recovered and wall triangles overlapping its
  cross-section are dropped (`clip_opening_flaps`), sparing the reveal/jamb
  faces on the boundary.

Both passes are gated to provably-broken cutters and are a no-op on clean
openings, so well-formed models are byte-identical.

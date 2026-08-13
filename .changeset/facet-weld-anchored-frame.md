---
"@ifc-lite/geometry": patch
---

Fix `weld_near_coplanar_facets` failing to weld authored-coplanar facets on hosts at ordinary site coordinates (hundreds to thousands of metres from the origin).

The plane offset used to gate the weld was computed as `n·v` at the facet's raw world-frame vertex. A per-facet normal-direction error of the same tiny scale the weld already exists to correct — independent f32 re-quantisation between adjacent faces — was amplified by the vertex's absolute position magnitude, turning a sub-tolerance offset gap into one that blew through `MAX_OFFSET_JITTER`. Only coordinates beyond 10,000 m trigger recentring upstream, so this left ordinary site coordinates fully exposed: authored-coplanar facets stayed fragmented, reintroducing the far-corner sliver fan the weld was written to remove (#1007, host #1112).

The fix anchors the normal and offset computation to a local frame — subtract the mesh's first canonical vertex before the plane math, add it back before returning positions — so the dot product multiplies a mesh-extent magnitude instead of the world-frame position. Existing tolerances (`MAX_OFFSET_JITTER`, `MAX_VERTEX_MOVE`, `POSITION_DEDUP_GRID`) are unchanged. Near-origin output is bit-identical (verified against `mesh_welding_calibration.rs`'s duplex M_Fixed window fixture, hash-for-hash).

Two separate, pre-existing limitations at these magnitudes are not addressed here and are reported, not silently patched: `POSITION_DEDUP_GRID` (1e-4 m) becomes finer than `f32`'s own storage ULP beyond roughly 840 m, so Step 1's vertex dedup can miss genuinely-coincident corners; and the anchoring fix bounds the residual offset gap to the anchor-to-cluster distance (mesh scale), not fully to zero, for a host whose first vertex sits far from the cluster being welded.

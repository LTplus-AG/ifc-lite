---
"@ifc-lite/wasm": patch
---

Geometry-correctness fixes from the T1-T6 vs IfcOpenShell sweep (#1788):

- Batched void subtraction now verifies the lenient (non-conforming) batch against the sum of per-cutter intersection volumes instead of re-running the sequential subtract chain. The chain re-jitters its own seams cut-over-cut and under-cuts multi-void walls, so a perfect batch was being rejected in favour of the broken sequential fallback — leaving one Poroton wall opening entirely uncut (ISSUE_098 T6 `fail:opening-not-cut`) and fragmenting/drifting the volume of five sibling walls.
- A void cut that keeps the host's triangle count but moves its volume (a miter/end cut replacing a 12-tri box with another 12-tri box) is no longer misread as "no change" — previously the perfect cut was discarded and the #635 AABB fallback carved the cutter's world-axis box instead (ISSUE_129 `IGC_MUR` wedge wall).
- New stray-shard sweep after void cutting: faces with no original-host material on either side (misclassified extended-cutter fragments up to ~1 m off a plan-rotated wall's plane, invisible to the world-AABB clip) are provably not part of `host − openings` and are dropped, with vertex arrays compacted so bounds/hull readers no longer see the shards.
- Profile smooth-curve simplification (RDP) now caps its epsilon at an absolute 10 mm (converted through the file's length unit) instead of scaling unboundedly with profile size — a 2.5 m curved slab's correctly-tessellated 4-arc boundary was being decimated from ~60 to 17 points (ISSUE_098 `1AR_PAV_CS008` slabs, voxel-IoU 0.64 vs IfcOpenShell). Window-scale openings are unaffected.

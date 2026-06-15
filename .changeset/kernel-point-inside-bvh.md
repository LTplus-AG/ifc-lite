---
"@ifc-lite/geometry": patch
---

Speed up the exact CSG kernel's boolean classification with a BVH, cutting its O(N²) operand scans to O(N log N) — byte-identical output.

`boolean_vids` decides each arrangement triangle's keep/drop by scanning the *entire* opposite operand per triangle: an exact ray-cast (`point_inside`) for in/out, plus an exact coincident- and near-coplanar-face probe (`on_surface_normal` / `near_on_surface_normal`). On boolean-heavy meshes (e.g. structural steel with hundreds of host triangles per cut) these are the dominant cost. The kernel now builds one median-split AABB BVH over the operand and queries it per triangle — a conservative ray query for the in/out test and a band-radius point query for the coincident-face test — so the expensive exact predicate runs only on the handful of candidates instead of every triangle.

The BVH is a pure prefilter: its candidate set is a guaranteed superset of the exact hits (a small padding absorbs f64 slab/containment rounding), the in/out result is a crossing-parity count (order-independent), and the coincident test reduces to "any candidate matches" (also order-independent). So the boolean output — and the pinned sign / boolean / retriangulation determinism manifests — are unchanged. On a real Tekla model this trims ~12% off total serial geometry time; the win grows with operand size and applies to every boolean-heavy model.

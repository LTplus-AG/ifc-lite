---
'@ifc-lite/geometry': patch
---

Stop `point_inside`'s exact ray-cast parity check rescanning its target mesh's bounding box on every query.

`point_inside` (`kernel/arrangement/classify.rs`) computed `tris_aabb(tris)` — an O(N) scan of every triangle — on each call, purely to size its far ray endpoint. Every caller already holds a box that contains the same triangles: `BComponents::inside` its cached, padding-inflated per-component box; `boolean_vids_components`'s regime-2 probe the BVH's already-computed root box; `union_all` each mesh's box, now hoisted out of its per-probe loop instead of being recomputed on every other mesh's boundary triangle. `point_inside` now takes that box as a parameter instead of rescanning.

Passing a box that is a superset of the triangles' true bounds (the exact box, or one padded outward) cannot change the parity verdict: the far endpoint is only ever extended to clear whichever box it is handed, and clearing a bigger box means clearing the real one too, past which there are no more triangles left to cross. All three call sites pass a genuine superset — two are the exact box, one is the exact box padded outward — so this is a pure elimination of redundant scanning, not a behavior change. Pinned by a test that checks both halves: a superset box gives a byte-identical verdict to the exact box, and (so that check is not vacuous) a box shrunk to no longer contain the mesh does flip a verdict for a deliberately constructed query.

This change was not benchmarked; disk constraints in the environment it was made in prevented a reliable release-mode timing run. Treat it as a redundant-computation removal with an unmeasured effect on wall time, not as a measured speedup.

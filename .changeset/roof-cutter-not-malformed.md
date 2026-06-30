---
"@ifc-lite/geometry": patch
---

Fix walls being sliced flat at a height (gable/roof top removed, windows left
floating) after #1440. The malformed-void-cutter detector (`opening_obb_if_malformed`)
flagged ANY cutter with a vertex >4 m beyond its near vertex cluster as "garbage".
A legitimate roof/gable cut — a watertight prism authored to reach far up (e.g.
~900 m) to clip a wall down to the roofline — trips that test on its structural
top vertices, so the real cut was skipped and replaced by a horizontal slab,
slicing every roof-capped wall flat.

Gate the detector on a closed-manifold check: a cutter that welds (by position)
to a closed 2-manifold is a VALID SOLID and is never reshaped, so roof/gable
prisms and clean opening boxes are spared. Only genuinely broken cutters
(self-intersecting / fin-laden tessellated voids, which leave boundary or
non-manifold edges) still get the #1440 repair. The spike/flap regression
(`multi_body_void_spike`) and the full geometry suite stay green; output matches
the pre-#1440 (correct) result byte-for-byte on the reported model.

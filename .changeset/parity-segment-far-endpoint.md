---
'@ifc-lite/geometry': patch
---

Stop the exact CSG kernel deleting a face of the host when the cutter sits outside it.

`point_inside` decides inside/outside by counting exact ray crossings along a segment from the query point to `p + dir * far_l`. `far_l` came from `operand_extent` of the OTHER operand, sized from that operand's own coordinates, while the query point is a centroid of THIS one. When the query point sat outside the other solid on the low-corner side of the ray direction, the segment ended INSIDE that solid: it counted the entry crossing, never reached the exit, and odd parity reported an outside point as inside. In a difference that drops the triangle, so a whole face of the host disappeared and the result came back as an open shell.

Because the shell is open its signed volume is not a volume, which is how this hid: one reported case read as "1.0 m3 removed" when in truth a single 1.28 m2 face was missing and nothing had been cut at all.

The segment's far endpoint is now guaranteed to clear the target's bounding box, walking out to the first escaping face plus a margin when the default endpoint would land inside. It is lengthened only in that case, which is exactly the state where the old parity was meaningless. A query whose endpoint was already outside the box keeps a byte-identical segment. That is deliberately narrower than "every previously-correct query is untouched", which is false: on a non-convex operand a point can sit inside the bounding box and outside the solid, where the old answer was already right and the segment does change. Both endpoints are outside the solid, so both parities agree. The escape face is chosen per axis by the ray direction's sign rather than assuming the direction is all-positive, and that is pinned by a test: the previous form silently depended on it, and negating one component made the endpoint land back inside the box.

This is not about touching or coplanar operands, which is where the investigation started. A purely disjoint pair fails the same way. Measured against an independent analytic oracle over axis-aligned box operands, the predicate reports 454 wrong verdicts in 120,000 queries before this change and 0 after, with no new false-outside verdicts. That is the committed gate, so the figure is reproducible by reverting the change and running it.

Gated by nine pinned end-to-end cases that each fail on the previous code, and by a differential of the predicate against the analytic oracle, which is the gate for the class rather than for the reported symptom.

Booleans do not stop tearing altogether. A separate pre-existing family survives this fix, concentrated in overlapping and rotated operands, and is tracked on its own.

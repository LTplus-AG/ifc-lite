---
'@ifc-lite/wasm': patch
---

Fix hairline cracks in void-cut geometry. `consolidate_coplanar` re-triangulates each
coplanar plane bucket independently, and its collinear simplify could drop a boundary
vertex that the abutting bucket keeps — leaving the shared edge spanned by one long
edge on one side and two short ones on the other. That T-junction renders as a
hairline crack under DoubleSide.

The pass now conforms seams across buckets. What separates a genuine seam vertex from
an `i_overlay` phantom is the simplify's own judgment read across buckets: a real seam
vertex is a hard corner in the abutting bucket, so it survives that bucket's simplify;
a phantom is near-collinear in every bucket that touches it and is dropped everywhere.
Today's output is emitted first and the conformed mesh is taken only when it is fully
watertight, so a host can never come out worse than before.

Measured over 116 fixtures and 1355 void-hosting elements: total unmatched boundary
edges 18252 to 17792, elements with any tear 238 to 199, and elements whose body is a
closed solid yet not watertight 80 to 41. Also unifies the analytic prism cut's new
crossing vertices at ulp scale, which fixes the case where two host faces sharing an
edge computed the same point one float step apart.

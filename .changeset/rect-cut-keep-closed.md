---
"@ifc-lite/wasm": patch
---

Keep an exactly closed rectangular-opening cut closed when coplanar consolidation would open it. A thin residual web between two authored openings (a gap of tens of microns, exposed by #7942) lost its rim faces and left open edges.

The raw closed cut is larger than the consolidated one, so an affected host keeps extra triangles; this happens per host and fired on 0 of 300 random walls.

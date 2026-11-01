---
"@ifc-lite/wasm": patch
---

Two openings authored flush, whose shared edges overlap only in part, are now cut as one opening. Before the coaxial footprint union, each footprint vertex was snapped onto an earlier footprint, which closes a seam only where both ends of the shared span are vertices of the later footprint. Where one end is a corner of the earlier footprint lying on the later one's edge, that edge stayed a rounding off the corner, the union kept two prisms, and a strip of host survived between them whenever the seam was not axis-aligned in the cut frame. Every edge is now split at each other footprint's vertex within the same noise radius, so both carry the shared span with the same endpoints and the union fuses them. On ISSUE_129 slab #12381 (a rectangle against a pentagon, flush for 1.32 m) this removes 3.16 m2 of strip faces and 4 slivers.

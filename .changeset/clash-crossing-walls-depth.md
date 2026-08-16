---
"@ifc-lite/clash": patch
---

Stop reporting a wall's full height as the penetration depth where two walls cross.

Two walls meeting at an X-junction — 200 mm thick, 3 m tall, one running along X and one along Y — reported `penetration 3.000 m` as a certified measurement. The shared volume is a 0.2 x 0.2 x 3 m column, so 0.2 m is the honest depth, and that is what the release before this one reported.

The box-to-box minimum translation distance for that pair really is 3.0: the cheapest way to slide the two walls apart is straight up, along their shared height. That is the reason the exact box depth is withheld from any pair where one member pierces the other clean through — the number is then dominated by the piercing member's own extent, not by the material it actually crossed. The guard that detects the shape required the piercing cross-section to sit *strictly* inside the other's, with a real margin. At an X-junction each wall does pierce the other clean through in thickness, but the two walls are the same height, so that axis ties exactly and the margin rejected the pair. The depth was then certified as measured and reached the user with no "estimate" qualifier.

The containment test now admits a cross-section that touches the other's edges, so the tie no longer disqualifies the pair. What still disqualifies a pair is the separate test that the piercing member pokes out past the other on *both* ends, which is untouched: stacked layers sharing a footprint, and a footing embedded into a slab from above, both keep their measured depth.

Walls of unequal heights were affected too (a 3 m wall crossing a 2.5 m one reported 2.5 m), and so were crossing members of any size whose overlap ties on one axis.

Also lands a brute-force oracle for the BVH-accelerated point-in-solid test, on a 2048-triangle sphere and a concave L-prism: 20,000 pseudo-random points each plus every triangle vertex probed either side of the surface, compared against an exhaustive scan over every triangle. Both kernels agree with the scan on every probe.

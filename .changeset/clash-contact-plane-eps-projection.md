---
"@ifc-lite/clash": patch
---

Fix fabricated coplanar contacts far from the origin in the contact narrow phase. The scaled plane-distance tolerance took the max abs coordinate over all three axes of both world AABBs, so an axis orthogonal to the tested plane normal could inflate the tolerance past a genuine clearance (2 mm clearance read as coplanar at 10 km along an unrelated axis). Per-axis f32-ULP noise amplitudes are now projected onto each tested plane's own normal, preserving the 1e-6 floor.

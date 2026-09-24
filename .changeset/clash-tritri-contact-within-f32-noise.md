---
"@ifc-lite/clash": patch
"@ifc-lite/wasm": patch
---

Clash detection no longer reports flush and coplanar contacts as hard clashes because f32 rounding pushed two coincident surfaces a ULP through each other, and the verdict for such a pair no longer depends on where the model sits in world space.

The triangle-triangle test both kernels share decided "touching" on an exact floating-point tie: a separating axis counted only if one triangle's projection ended at or before the other's began. Vertices reach the clash kernel as f32, so two surfaces authored flush land on the same or on adjacent f32 values, and which one a rigid translation of the model decides. One ULP either way turned a contact into a crossing, and a crossing sent the pair to the depth path, where it could come out as a hard clash at an AABB estimate the size of an element. The same tie decided every coplanar pair: for two coplanar triangles all the axes the test had are the shared normal, so it could not see an in-plane gap at all — a 20 mm clearance between a rotated panel and mullion was reported as a 1.38 m hard clash at the origin.

Overlap within the f32 quantisation band of the tested axis now counts as contact. The band is per coordinate axis (`max(1, |c|) * 2^-22`, the scale the precision floor already uses) and projected onto each tested axis, so a coordinate axis orthogonal to it contributes nothing however far from the origin the model is. The edge-edge axis cutoff is now relative to the edge lengths, so axes between short edges are no longer all discarded below ~1 mm.

On the buildingSMART Infra-Bridge sample this moves 48 of the 50 CLI-default hard clashes to touch (each measured at a mesh distance of at most 1.4e-6 m); no pair appears or disappears. A genuine penetration larger than the f32 resolution of its own coordinates is still reported as hard.

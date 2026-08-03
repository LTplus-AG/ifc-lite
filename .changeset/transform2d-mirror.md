---
'@ifc-lite/wasm': patch
---

Fix the 2D symbolic transform (floor-plan / annotation rendering) to represent a mirroring `IfcMappedItem` MappingTarget (#1994). `Transform2D` (`rust/processing/src/symbolic/transform.rs`) stored its linear block as a `(cos_theta, sin_theta)` similarity — rotation + uniform scale + translation — which has no reflection component, so a MappingTarget whose `Axis2` disagrees with the right-handed perpendicular of `Axis1` drew its plan symbols un-mirrored while the 3D mesh path (fixed in #1990) mirrored correctly. `Transform2D` now carries a full 2x2 linear block (`m00, m01, m10, m11`), and `parse_cartesian_transformation_operator` derives handedness from `Axis2` the same way `router/transforms/operator.rs` does for the 3D path, so both paths agree.

Non-mirroring geometry (rotation, uniform scale, translation, identity) is bit-equivalent to before. Text/annotation glyphs stay non-mirrored under a mirroring transform by construction: their direction reads only the local X-axis column, which a mirroring `Axis2` never touches.

Impact is low — no model in the 63-model test corpus carries a mirroring operator — so this is a correctness fix demonstrated by a hand-authored fixture, not an observed rendering failure.

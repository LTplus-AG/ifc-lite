---
"@ifc-lite/geometry": patch
---

Cut openings in rotated walls orthogonally instead of as an oversized bounding box.

`classify_openings` routed an opening onto the fast world-axis-aligned-AABB cut
path whenever its extrusion direction was within ~18° of a world axis (the
`is_axis_aligned_direction` tolerance of 0.95). A wall rotated in plan by up to
~18° — a façade a few degrees off the project grid, or an entire building
rotated relative to the world axes — therefore had its windows/doors cut by the
world-axis-aligned *bounding box* of the rotated opening box. That AABB is
strictly larger than the real opening, so the cut removed wall material outside
the opening, leaving a hole bigger than the window and skewed to the world grid
instead of orthogonal to the wall (#1167, "weird wall hole cutting").

The axis-aligned tolerance is now `cos(1°)`, so any meaningfully rotated wall is
cut with its true oriented opening box (the exact-mesh path), which removes
exactly the opening volume. Genuinely axis-aligned walls — whose direction
cosines are exact up to f32 mesh-normal noise — stay on the fast path with a
~1000× margin. Adds regression test `rotated_wall_opening_is_not_overcut`
(a 15°-rotated wall over-cut 0.66 m³ before, exactly 0.54 m³ after).

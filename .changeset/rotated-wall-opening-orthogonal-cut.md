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
cut with its true oriented opening box rather than an oversized world-axis box.
Genuinely axis-aligned walls — whose direction cosines are exact up to f32
mesh-normal noise — stay on the fast path with a ~1000× margin.

Cutting that oriented box in world space is fragile, though: the exact kernel's
coplanar re-triangulation leaves rim slivers / hairline cracks on tilted planes
(fragmented holes), worst with the segmented profiles real exporters emit. So
for a vertical wall rotated in plan, every opening is now cut in the wall's
shared axis-aligned frame — the host is rotated into that frame (where the
openings are world-axis-aligned boxes), cut via the same numerically-clean path
a straight wall uses (`weld_near_coplanar_facets` + the watertight `rect_fast`
cellular cut), and rotated back. A rotated wall therefore cuts identically to a
straight one: exactly the window volume, watertight, no slivers — at any
rotation angle, for clean or tessellated profiles. The path is tightly scoped
(all openings tilted rectangular boxes sharing one orientation, depth axis
~horizontal), so roof / floor / sloped openings keep their existing path.

Adds regression tests `rotated_wall_opening_is_not_overcut` (a 15°-rotated wall
over-cut 0.66 m³ before, exactly 0.54 m³ after) and
`rotated_opening_cuts_clean_at_every_angle` (watertight, no slivers, exact
volume across 3–45° for clean and tessellated profiles).

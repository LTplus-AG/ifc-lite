---
"@ifc-lite/geometry": patch
---

Fix oversized, fragmented openings cut from walls rotated in plan (#1167, "weird
wall hole cutting").

A vertical wall rotated in plan (a façade off the project grid, or a whole
building rotated relative to the world axes) had its windows and doors cut
wrong: the openings came out far larger than they should and the wall fragmented
into rim slivers and cracks. On a real reporter model the worst wall lost 86% of
its volume to five openings and came back with ~236 unpaired edges. Two causes,
both from cutting a *tilted* opening box in *world* space:

- The opening was routed onto the fast world-axis-aligned-AABB cut path whenever
  its extrusion direction sat within ~18° of a world axis (the
  `is_axis_aligned_direction` tolerance of 0.95). The AABB of a rotated box is
  strictly larger than the box — an oversized, grid-aligned hole.
- Even via the exact mesh subtract, a tilted cut at large world coordinates
  (≈150 m, where f32 ≈ 15 µm) over-cuts and fragments.

The tolerance is tightened to `cos(1°)`, and — the real fix — a plan-rotated
wall is now cut in its own axis-aligned, origin-centred frame: the host and its
openings are rotated into that frame (where they are world-axis-aligned and near
the origin, so the exact subtract is clean and f32-precise), cut there (clean
boxes take the watertight `rect_fast` path; brep/curved openings keep their
mesh), then the result is rotated back. A rotated wall now cuts like a straight
one — the right volume, watertight, no slivers — at any rotation angle. The path
is tightly scoped to plan-rotated walls, so axis-aligned walls and
roof/floor/sloped openings are untouched.

Adds regression tests: `rotated_wall_opening_is_not_overcut` and
`rotated_opening_cuts_clean_at_every_angle` (synthetic, 3–45°, clean and
tessellated profiles), plus `rotated_wall_openings_not_overcut_or_fragmented`,
pinned on a real `IfcWallStandardCase` isolated from the reporter's model (five
openings, full placement chain) — 22.5 m³ over-cut + 236 unpaired edges before,
~13 m³ and watertight after.

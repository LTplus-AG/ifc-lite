---
"@ifc-lite/wasm": patch
---

Add regression tests for non-box `IfcOpeningElement` classification (#547). PR #640 already routes low-tessellation non-rectangular openings (trapezoids, chamfered rectangles, beveled windows, coarse arcs) through CSG via `is_rectangular_box_mesh` + `infer_opening_frame`. This change adds end-to-end coverage that loads inline IFC fixtures and asserts the cut respects the actual opening profile (trapezoid narrow-edge boundary vertices appear in the voided wall, and many tessellated-box openings on a single wall are all cut without the CSG-budget cap silently dropping any).

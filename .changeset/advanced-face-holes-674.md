---
"@ifc-lite/wasm": patch
---

Fix the wedge-shaped Z-fight artifact on the door-glass panel
of Revit-exported `IfcDoor` fixtures (issue #674 true root cause,
PR #802).

`process_planar_face` in `advanced_face.rs` triangulated each
`IfcFaceBound` of an `IfcAdvancedFace` as an independent solid
polygon, ignoring the IFC 4.3 schema's `IfcFaceOuterBound` vs
inner-bound distinction. For a face with one outer rectangle +
one inner hole rectangle (the door panel's glass cutout), this
emitted:

  - outer ring: 2-tri solid quad covering the whole face
  - inner ring: 2-tri solid quad covering the hole, with the
    schema-imposed reversed winding → opposite normal

Identical plane, opposite normals, overlapping in the cutout's
footprint. The WebGPU pipeline runs `cullMode: 'none'`, so the
canceling pair rendered as the visible wedge.

Fix: identify the outer bound (preferring the typed
`IfcType::IfcFaceOuterBound`, falling back to the first bound for
files that emit only `IfcFaceBound`), treat siblings as holes,
honour the per-bound orientation flag, and call the existing
`triangulate_polygon_with_holes` helper once — the same pattern
the FacetedBrep path in `brep.rs` already uses.

Door panel #712 on the issue-604 fixture now emits 32 triangles
(matching IfcOpenShell's reference), up from 24 pre-fix. The
same broken code path was the fallback for every other surface
type in `advanced_face.rs` (B-spline edge cap, cylindrical /
conical / spherical / toroidal / surface-of-linear-extrusion
fallbacks); all of those now also produce correct annular
triangulations on faces with inner bounds.

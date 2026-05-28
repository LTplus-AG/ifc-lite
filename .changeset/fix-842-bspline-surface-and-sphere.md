---
"@ifc-lite/wasm": patch
---

Render `IfcRationalBSplineSurfaceWithKnots` /
`IfcBSplineSurfaceWithKnots` surfaces and `IfcSphere` CSG primitives
when they appear directly under a `'Surface3D'` shape representation
(issue #842).

The B-spline tessellator (Cox-de Boor + rational weights) already
existed for surfaces nested inside `IfcAdvancedFace`, but standalone
surface items had no processor registered and `Surface3D`
representations were filtered out at the router. Wire the same
tessellator behind a `BSplineSurfaceProcessor`, add a `SphereProcessor`
for the remaining `IfcCsgPrimitive3D` leaf used in the reporter's
fixture, and allow `'Surface3D'` representations through the
representation-type allow-list in `process_element` /
`process_element_with_submeshes`.

Regression coverage:

- `rust/geometry/tests/issue_842_bspline_and_sphere.rs` — full pipeline
  against the reporter's NURBS marker fixture, asserting that the proxy
  containing the two 5×5 rational B-spline patches plus nine IfcSphere
  markers produces both surface tessellation and sphere meshes spanning
  the expected X extent.

Fixture `tests/models/issues/842_rational_bspline_surface.ifc` added
to the manifest (5.7 KB).

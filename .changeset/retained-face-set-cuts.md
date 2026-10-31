---
"@ifc-lite/wasm": minor
"@ifc-lite/cli": minor
---

Retained face sets can now be cut and copied. A Boolean, opening, mirrored or non-uniform copy of an `IfcTriangulatedFaceSet` or `IfcPolygonalFaceSet` stitches a closed solid from its authored triangles, up to 8,192 triangles, and keeps persistent `row(k)` face keys through the cut. An open shell or a larger set refuses `operation_unsupported` there; uncut face sets are unaffected. A retained engine now needs a worker built with the polyhedron capability. The default exact engine and default wasm are unchanged.

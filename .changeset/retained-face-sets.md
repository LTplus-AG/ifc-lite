---
"@ifc-lite/wasm": minor
"@ifc-lite/cli": minor
---

Retained products can now use `IfcTriangulatedFaceSet` and `IfcPolygonalFaceSet` bodies. An uncut face set publishes its authored triangles in full f64 with no kernel call, including open shells, and every triangle carries a persistent face key `row(k)` naming its authored row. Face sets with a texture or indexed colour palette refuse `appearance_unsupported`, and a Boolean, opening or affine copy of a face set still refuses. The default exact engine and default wasm are unchanged.

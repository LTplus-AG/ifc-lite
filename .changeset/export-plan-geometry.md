---
"@ifc-lite/wasm": minor
---

Rust only, in `ifc-lite-export`; nothing in the wasm package changes. An export plan's `Patch` can now replace a product's body geometry with a triangle mesh and an optional colour. The new body is written in what the source schema can express (`IfcTriangulatedFaceSet` in IFC4 and IFC4X3, a faceted brep or surface model in IFC2X3), the old shape is never edited, and records it leaves unused are pruned while shared ones survive. Other representations dropped with the old shape are listed in `WriteReport::dropped_representations`.

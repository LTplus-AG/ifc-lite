---
"@ifc-lite/wasm": patch
---

LandXML parcel area for multi-loop parcels now follows geometry, not winding (#5179). Disjoint `CoordGeom` loops are separate parts and their areas add. A loop counts as a hole only when it is nested inside another loop of the same parcel, and an island inside a hole counts as a part again. Two equal, disjoint loops wound in opposite directions no longer cancel to zero and get dropped as a "zero-area boundary".

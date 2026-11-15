---
"@ifc-lite/wasm": patch
---

A face written as several `IfcFaceOuterBound` loops meshes as its regions on every product: a loop in no other loop is a region and a loop inside another is its opening, where the generic pipeline kept the last loop as the ring and made the earlier ones holes.

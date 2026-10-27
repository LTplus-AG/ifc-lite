---
'@ifc-lite/wasm': patch
---

A Bonsai drawing camera (an `IfcAnnotation` with `ObjectType` `DRAWING`, carrying an `EPset_Drawing` and the camera's extent as a box body) is no longer meshed, so its extent no longer shows as a large solid block over plans, sections and 3D views. Every other `IfcAnnotation` (grid lines, texts, markup) draws as before.

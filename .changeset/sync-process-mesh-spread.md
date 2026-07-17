---
"@ifc-lite/geometry": patch
---

Fix `GeometryProcessor.process()` throwing `RangeError: Maximum call stack size exceeded` on models with more than ~65k meshes (e.g. 169MB Holter tower, ~110k meshes). The synchronous collect path spread the whole mesh batch into a single `Array.push(...)` call, which passes one argument per mesh and blows V8's argument ceiling; it now appends in a loop. The streaming path was never affected.

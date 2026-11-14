---
"@ifc-lite/geometry": patch
---

A flat batch's usual mesh metadata (`expressId`, `ifcType`, colour, origin, local bounds, local-to-world transform, geometry class and ids, geometry hash, box and volume) now travels in a few typed columns instead of a dozen small objects per mesh. The main thread rebuilds each mesh with the same keys in the same order and the same values. A mesh with any other field still travels whole.

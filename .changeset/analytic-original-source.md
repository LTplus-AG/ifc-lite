---
'@ifc-lite/wasm': patch
---

The analytic extrusion and profile description now carries the original authored profile, curve, placement and direction records (coefficients, trim selectors, traversal flags and the file's plane-angle scale) beside the interpreted segments, so a consumer can read what the file said rather than a reconstruction. Mesh output is unchanged.

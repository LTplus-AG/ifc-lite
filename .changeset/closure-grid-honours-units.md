---
"@ifc-lite/wasm": patch
---

The CSG open-topology diagnostic now measures its 0.1 mm closure tolerance in physical units on millimetre and other non-metre models, so a boolean result with only micron-scale gaps is no longer counted as a `KernelError` failure. Geometry output is unchanged.

---
"@ifc-lite/wasm": patch
---

The CSG open-topology check now measures its 0.1 mm closure tolerance in physical units on millimetre and other non-metre models, so a boolean result whose only gaps are micron-scale is no longer counted as a `KernelError` failure. On the polygonal-bounded half-space group cut, that record also decides whether the moved-cutter repair may run, so geometry on non-metre models can change where such gaps occurred. No mesh changed on the six locally available millimetre fixtures that use these cuts.

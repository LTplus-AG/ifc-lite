---
"@ifc-lite/sdk": patch
---

`bim.bcf.sectionPlaneToClippingPlane()` and `bim.bcf.clippingPlaneToSectionPlane()` each accepted only their first argument and silently dropped the `bounds` argument `@ifc-lite/bcf`'s underlying functions require to place an absolute location or compute a percentage position. A documented call — passing a section plane or clipping plane plus the model's bounds, exactly as `createViewpoint()`'s own error message recommends — threw a raw, unhandled `TypeError` reading `bounds.min`/`bounds.max` from inside the library instead of forwarding it or returning a usable result.

Both wrappers now accept and forward `bounds`, matching their `@ifc-lite/bcf` signatures.

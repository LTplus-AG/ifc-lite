---
"@ifc-lite/sdk": patch
---

`bim.bcf.cameraToOrthogonal()` accepted only the `camera` argument and silently dropped `viewToWorldScale`, the second, required argument `@ifc-lite/bcf`'s underlying `cameraToOrthogonal()` needs to compute the camera's view extent. Unlike the `sectionPlaneToClippingPlane`/`clippingPlaneToSectionPlane` converters fixed for the same reason, the underlying function does not dereference the dropped argument, so the call did not throw: it returned a well-formed-looking `BCFOrthogonalCamera` with `viewToWorldScale: undefined`. `ViewToWorldScale` is a required element when the camera is written to a BCF archive, so a viewpoint built this way failed later, at `bim.bcf.write()`, far from the call that dropped the argument.

`cameraToOrthogonal()` now accepts and forwards `viewToWorldScale`, matching its `@ifc-lite/bcf` signature.

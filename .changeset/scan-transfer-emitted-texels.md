---
"@ifc-lite/wasm": patch
---

Require observed interior raster texels before a scan appearance transfer can be applied. Report centroid observations separately so sparse centroid-only coverage cannot produce an applicable atlas containing only the old appearance.

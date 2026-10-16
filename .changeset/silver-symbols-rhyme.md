---
"@ifc-lite/geometry": patch
"@ifc-lite/parser": patch
"@ifc-lite/pointcloud": patch
---

Share emitted worker URL rewriting and verification across worker packages. Inspect every emitted module so new callers such as the geometry worker pool resolve shipped JavaScript workers in npm installations. Preserve parser all-asset verification and verify script assets separately where WASM is supplied by another package.

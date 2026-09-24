---
"@ifc-lite/sdk": patch
---

Deprecate `ExportGltfOptions`. `bim.export` has no glTF or GLB method, so nothing reads these options. The type will be removed in the next major (#5701).

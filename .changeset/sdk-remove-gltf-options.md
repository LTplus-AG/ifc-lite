---
"@ifc-lite/sdk": major
---

Remove `ExportGltfOptions`. `bim.export` has never had a glTF or GLB method, so nothing read these options, and the type implied a capability the SDK doesn't have (#5701). It was deprecated in 7.1.x. To migrate, drop any import of `ExportGltfOptions`; nothing else changes.

---
"@ifc-lite/geometry": patch
"@ifc-lite/renderer": patch
"@ifc-lite/wasm": patch
---

Compact geometry (`compactGeom`, off by default): each encoded row carries its first source vertex (`anchors`), where the f32 load takes a mesh's spatial chunk, so pages group meshes by the same buckets even within half a lattice step of a chunk plane. Payloads from an older wasm build, without anchors, keep working (the first record decides, as before).

---
"@ifc-lite/renderer": patch
---

Preserve UVs and shared texture resources when large meshes are split for streaming, fixing white rendering of textured captured objects above the fragment limit.

Hydrate picking geometry for models containing only textured meshes, making captured objects selectable by click and rectangle selection.

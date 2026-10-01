---
"@ifc-lite/viewer": patch
---

Use the column writer's storey-local +X default when drawing initial parameter fallback geometry. Columns authored without RefDirection now keep the same section orientation as an explicit [1, 0, 0] in translated or rotated storeys when native remeshing declines. Native-first meshing and Undo/Redo are unchanged.

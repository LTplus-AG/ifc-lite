---
"@ifc-lite/viewer": major
---

Use the column writer's storey-local +X default when drawing initial parameter fallback geometry. The exported authoredElementMeshPayload function now maps an omitted RefDirection through the storey frame, instead of allowing the fallback mesh builder to use model-local +X. This changes the meaning of an existing default and requires a major viewer release.

Consumers should pass the intended storey-local RefDirection explicitly when section heading matters. Columns authored without RefDirection now match an explicit [1, 0, 0] in translated or rotated storeys when native remeshing declines. Native-first meshing and Undo/Redo are unchanged.

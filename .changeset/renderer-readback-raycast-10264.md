---
"@ifc-lite/renderer": minor
---

`Renderer.setReadbackRaycastMeshes(meshes | null)` hands flat pieces read back from local storage to the next `raycastScene` / `raycastSceneMagnetic` (#10264). Measurement and snapping can then work on a scene whose CPU geometry was released. The pieces are tested beside the resident ones, under the same hide/isolate and section clip. The host places them in the current model frame (`getScene().placeAppearanceSource`), keeps them alive, and passes `null` to clear them. Nothing changes for callers that never set any.

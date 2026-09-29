---
"@ifc-lite/viewer": patch
"@ifc-lite/geometry": minor
---

Resizing a wall now rebuilds its 3D shape with the same wasm mesher the model was loaded with, so the wall is cut by its openings and its windows and doors move with it (#6232). Undo and redo rebuild it again. The rebuilt mesh lands in the model's own coordinate frame, including georeferenced and federated models, which also corrects the position of walls authored in the viewer on models whose storeys are not at the origin. When a shape can't be rebuilt, a notice says why and the edit is kept. That happens for a model not loaded from IFC, or one whose mesh is shared with other elements. `RemeshClient` gains `styleWire(source)` for capturing a model's style colours once, and marks itself dead when its worker fails or a request times out, so later requests reject instead of hanging.

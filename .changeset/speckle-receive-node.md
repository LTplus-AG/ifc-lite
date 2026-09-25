---
"@ifc-lite/flow-nodes": minor
---

Add the `speckle.receive` flow node: fetches a Speckle model version (modern `/projects/<p>/models/<m>[@<v>]` URLs and legacy stream commit/object URLs) through the gated network request path, and writes its walls, floors, flat roofs, columns and beams into a target storey with Revit parameters as property sets. Anything the v1 mapping cannot reproduce is reported by type, reason and count. Display meshes are not written, and bodies are rebuilt parametrically.

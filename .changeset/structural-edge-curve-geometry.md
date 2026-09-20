---
"@ifc-lite/wasm": minor
"@ifc-lite/server-bin": minor
---

Render `IfcEdgeCurve` and `IfcOrientedEdge` geometry on `IfcStructuralCurveMember` representations. Curved members now reuse the bounded canonical edge samplers and honor both `SameSense` and `Orientation`, while cyclic file-authored edge references fail deterministically instead of recursing.

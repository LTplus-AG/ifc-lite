---
"@ifc-lite/create": minor
"@ifc-lite/cli": patch
---

Allow `resolveSpatialAnchor` to read the effective entity set through an optional mutation view. In-store authoring can now target a created storey or placement and will not reuse deleted or retyped-away owner history, contexts, storeys or placements (#5249). CLI and viewer authoring pass their live views.

---
"@ifc-lite/parser": patch
"@ifc-lite/export": patch
---

Centralize IFC STEP entity scan selection behind a typed scanner helper, remove the unused duplicate `parseEntityOnDemand` implementation, keep the legacy `parse()` adapter on the shared scan path, and route LOD0 export indexing through the same scanner.

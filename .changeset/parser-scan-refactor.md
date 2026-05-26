---
"@ifc-lite/parser": patch
---

Centralize IFC STEP entity scan selection behind a typed scanner helper, remove the unused duplicate `parseEntityOnDemand` implementation, and keep the legacy `parse()` adapter on the shared scan path.

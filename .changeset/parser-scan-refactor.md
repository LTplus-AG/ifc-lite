---
"@ifc-lite/parser": patch
"@ifc-lite/export": patch
"@ifc-lite/cache": patch
"create-ifc-lite": patch
---

Centralize IFC STEP entity scan selection behind a typed scanner helper, remove the unused duplicate `parseEntityOnDemand` implementation, keep the legacy `parse()` adapter on the shared scan path, route LOD exports through shared/adaptive ingestion paths, and persist cache entity-index columns to avoid cache reload rescans.

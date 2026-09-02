---
'@ifc-lite/parser': patch
---

`expandTypes` (the shared type-expansion every `byType()` query backend uses) used to walk a fixed nine-entry `IFC_SUBTYPES` table that only aliased `*StandardCase`/`*ElementedCase` pairs. Asking for an abstract EXPRESS supertype — `IfcBuildingElement`, `IfcElement` — is never a literal STEP entity type, so that table had no row for it and `byType('IfcBuildingElement')` silently matched nothing on a model full of walls, slabs and columns. `expandTypes` now delegates to `@ifc-lite/data`'s schema-driven descendant-closure resolver and takes an optional `schemaVersion` (defaulting to IFC4, matching the old table's implicit assumption when omitted).

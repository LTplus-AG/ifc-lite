---
'@ifc-lite/data': minor
---

Added `expandTypeNamesToDescendants`, a per-schema-version descendant-closure resolver over the bundled `ENTITIES_IFC2X3`/`ENTITIES_IFC4`/`ENTITIES_IFC4X3` tables: given a type name and the model's IFC schema version, it returns that type plus every type that has it as an ancestor (direct or indirect), matching only names that schema version actually declares. This backs `@ifc-lite/parser`'s `expandTypes`, which every `byType()` query surface (CLI, MCP, viewer SDK) shares.

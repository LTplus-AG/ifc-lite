---
'@ifc-lite/mcp': patch
---

`bim.query().byType(...)` and `count_entities`'s `type` filter now resolve an abstract EXPRESS supertype (e.g. `IfcBuildingElement`, `IfcElement`) to every concrete type the model's own IFC schema version declares under it, instead of silently matching nothing — the type expansion is now schema-aware, keyed off `store.schemaVersion`, via `@ifc-lite/parser`'s updated `expandTypes`.

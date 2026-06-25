---
"@ifc-lite/lists": minor
"@ifc-lite/lens": minor
---

Expose IFC `PredefinedType` as a selectable entity attribute in Lists and Lens. `ENTITY_ATTRIBUTES` (lists) and `ENTITY_ATTRIBUTE_NAMES` (lens) now include `PredefinedType`, so it can be used as a List column / condition and as a Lens "color by attribute" / rule criterion. The list engine resolves it through a new optional `ListDataProvider.getEntityPredefinedType(expressId)` accessor (implementers without it degrade gracefully). (#1364)

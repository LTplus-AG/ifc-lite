---
"@ifc-lite/export": patch
---

Fix a STEP export producing schema-invalid IFC for an empty property set or quantity set: `HasProperties`/`Quantities` are declared `SET [1:?]` (not OPTIONAL) in every bundled schema, so `()` and `$` are both invalid there. A property/quantity set with zero members — a legitimate placeholder created via `MutablePropertyView.createPropertySet`/`createQuantitySet` and left unpopulated — is now omitted from the export entirely, along with the `IfcRelDefinesByProperties` that would otherwise bind an entity to it.

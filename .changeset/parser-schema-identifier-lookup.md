---
"@ifc-lite/parser": patch
---

`getAttributeNamesForSchema` and `getAttributeTypeForSchema` now accept a FILE_SCHEMA identifier as well as a schema family: `IFC4X3_ADD2` resolves to the IFC4X3 layout, and `IFC2X3_TC1` / `IFC4_ADD2_TC1` to theirs, using the same rule as `detectSchemaVersion`. Before, the identifier was stripped to `IFC4X3ADD2`, matched no family and silently returned the IFC4 answer (e.g. `Description` instead of `Specification` for `IfcPropertySingleValue`). Callers passing `store.schemaVersion` are unaffected.

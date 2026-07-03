---
"@ifc-lite/lists": minor
---

`ColumnDefinition` gains two optional, execution-time-only fields: `quantityType` (the `QuantityType` a `source: 'quantity'` column resolved to) and `dataType` (the raw IFC measure value type a `source: 'property'` column resolved to, e.g. `"IFCVOLUMETRICFLOWRATEMEASURE"`). `executeList` populates them on the RESULT's columns from the first matching entity's quantity/property — the persisted `ListDefinition` authoring schema is never mutated.

This lets a consumer apply unit-aware display/export logic (the viewer's list export now honours its display-unit converter, issue #1573) without re-deriving a column's measure type from scratch. Existing consumers are unaffected: both fields are optional and `undefined` unless the caller opts in by reading them.

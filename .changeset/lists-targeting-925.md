---
"@ifc-lite/lists": minor
---

Lists can now target elements beyond IFC class (#925).

- `ListDefinition` with an empty `entityTypes` targets all model elements
  (resolved via the new optional `ListDataProvider.getAllEntityIds()`).
- `PropertyCondition.source` gains `material` | `classification` | `spatial`
  (storey), backed by optional provider accessors `getMaterialNames`,
  `getClassifications`, and `getStoreyName`.

All new provider methods are optional, so existing `ListDataProvider`
implementers keep working unchanged.

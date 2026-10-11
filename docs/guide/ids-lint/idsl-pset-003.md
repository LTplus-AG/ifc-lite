<!-- Generated from the rule metadata in packages/ids-authoring/src/lint/rules by packages/ids-authoring/scripts/generate-lint-docs.mjs. Do not edit by hand. -->

# IDSL-PSET-003: Quantity set with a non-measure data type or value

| Default severity | Kind | Scope | Quick fix |
|---|---|---|---|
| warning | static | specification | yes |

Quantities (Qto_ sets) are always numeric measures (length, area, volume, count, weight, time). A Qto_ requirement with a text data type such as IFCLABEL, or a non-numeric value, can never be satisfied by a real quantity.

## Example

```xml
<property dataType="IFCLABEL"><propertySet><simpleValue>Qto_WallBaseQuantities</simpleValue></propertySet><baseName><simpleValue>Length</simpleValue></baseName></property>
```

## Quick fix

Use the quantity's standard data type (where the tables define it). Quick fixes are proposals: they are op batches that pass the grounding gate and are never applied automatically.

## Suppressing

Add a suppression with a reason for `IDSL-PSET-003` (or `IDSL-PSET-*`) to the node, its facet, its specification or the document in the Studio sidecar (`meta.suppressions`).

[All lint rules](index.md)

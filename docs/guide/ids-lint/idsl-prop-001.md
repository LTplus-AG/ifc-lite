<!-- Generated from the rule metadata in packages/ids-authoring/src/lint/rules by packages/ids-authoring/scripts/generate-lint-docs.mjs. Do not edit by hand. -->

# IDSL-PROP-001: Property not in the standard property set

| Default severity | Kind | Scope | Quick fix |
|---|---|---|---|
| error | static | specification | yes |

The standard set does not define this property, so no conforming model carries it there. It is usually a typo, or a property that lives in another standard set.

## Example

```xml
<propertySet><simpleValue>Pset_DoorCommon</simpleValue></propertySet><baseName><simpleValue>FireRatng</simpleValue></baseName>
```

## Quick fix

Use the closest property of the set, or the standard set that defines this property. Quick fixes are proposals: they are op batches that pass the grounding gate and are never applied automatically.

## Suppressing

Add a suppression with a reason for `IDSL-PROP-001` (or `IDSL-PROP-*`) to the node, its facet, its specification or the document in the Studio sidecar (`meta.suppressions`).

[All lint rules](index.md)

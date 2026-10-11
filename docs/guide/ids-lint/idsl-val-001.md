<!-- Generated from the rule metadata in packages/ids-authoring/src/lint/rules by packages/ids-authoring/scripts/generate-lint-docs.mjs. Do not edit by hand. -->

# IDSL-VAL-001: Value not in the standard enumeration

| Default severity | Kind | Scope | Quick fix |
|---|---|---|---|
| error | static | specification | yes |

The standard property is an enumerated property and the required value is not one of its enumeration values. Enumeration values are compared case-sensitively, so conforming models can never carry it.

## Example

```xml
<propertySet><simpleValue>Pset_DoorCommon</simpleValue></propertySet><baseName><simpleValue>Status</simpleValue></baseName><value><simpleValue>New</simpleValue></value>
```

## Quick fix

Use the enumeration value with the same spelling in another case, or the closest one. Quick fixes are proposals: they are op batches that pass the grounding gate and are never applied automatically.

## Suppressing

Add a suppression with a reason for `IDSL-VAL-001` (or `IDSL-VAL-*`) to the node, its facet, its specification or the document in the Studio sidecar (`meta.suppressions`).

[All lint rules](index.md)

<!-- Generated from the rule metadata in packages/ids-authoring/src/lint/rules by packages/ids-authoring/scripts/generate-lint-docs.mjs. Do not edit by hand. -->

# IDSL-CARD-002: Optional requirement that checks nothing

| Default severity | Kind | Scope | Quick fix |
|---|---|---|---|
| info | static | specification | yes |

An optional requirement means "if present, it must comply". Without a value (or data type, or classification system) there is nothing to comply with, so it can never fail.

## Example

```xml
<property cardinality="optional"><propertySet>…</propertySet><baseName>…</baseName></property>
```

## Quick fix

Make it required, or remove it. Quick fixes are proposals: they are op batches that pass the grounding gate and are never applied automatically.

## Suppressing

Add a suppression with a reason for `IDSL-CARD-002` (or `IDSL-CARD-*`) to the node, its facet, its specification or the document in the Studio sidecar (`meta.suppressions`).

[All lint rules](index.md)

<!-- Generated from the rule metadata in packages/ids-authoring/src/lint/rules by packages/ids-authoring/scripts/generate-lint-docs.mjs. Do not edit by hand. -->

# IDSL-PROP-003: Numeric constraint without a data type

| Default severity | Kind | Scope | Quick fix |
|---|---|---|---|
| info | static | specification | yes |

The value is a numeric range or a numeric restriction, but the property has no dataType. The data type decides how values are compared (and which unit applies), so checkers may compare such a value as text or skip it.

## Example

```xml
<property><propertySet>…</propertySet><baseName>…</baseName><value><xs:restriction base="xs:double"><xs:minInclusive value="0"/></xs:restriction></value></property>
```

## Quick fix

Add the standard property's data type (when the set is standard). Quick fixes are proposals: they are op batches that pass the grounding gate and are never applied automatically.

## Suppressing

Add a suppression with a reason for `IDSL-PROP-003` (or `IDSL-PROP-*`) to the node, its facet, its specification or the document in the Studio sidecar (`meta.suppressions`).

[All lint rules](index.md)

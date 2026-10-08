<!-- Generated from the rule metadata in packages/ids-authoring/src/lint/rules by packages/ids-authoring/scripts/generate-lint-docs.mjs. Do not edit by hand. -->

# IDSL-CARD-004: Required specification with a narrow applicability

| Default severity | Kind | Scope | Quick fix |
|---|---|---|---|
| info | static | specification | yes |

A required specification fails any model with no applicable element. When the applicability is narrowed by a value (a property or attribute value, a classification, a material, a containment), a model that legitimately has no such element fails the whole specification. Optional is usually what is meant.

## Example

```xml
<applicability minOccurs="1">…<property>…<value><simpleValue>EI60</simpleValue></value></property></applicability>
```

## Quick fix

Make the specification optional. Quick fixes are proposals: they are op batches that pass the grounding gate and are never applied automatically.

## Suppressing

Add a suppression with a reason for `IDSL-CARD-004` (or `IDSL-CARD-*`) to the node, its facet, its specification or the document in the Studio sidecar (`meta.suppressions`).

[All lint rules](index.md)

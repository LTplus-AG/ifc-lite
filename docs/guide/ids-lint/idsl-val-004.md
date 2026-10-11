<!-- Generated from the rule metadata in packages/ids-authoring/src/lint/rules by packages/ids-authoring/scripts/generate-lint-docs.mjs. Do not edit by hand. -->

# IDSL-VAL-004: Simple value that looks like a comparison

| Default severity | Kind | Scope | Quick fix |
|---|---|---|---|
| warning | static | specification | yes |

A simple value such as ">25" or "≥ 0.9" is compared as literal text, so it only matches an element whose value is that text. Numeric limits are written as bounds (minInclusive, maxExclusive, …).

## Example

```xml
<value><simpleValue>&gt;= 30</simpleValue></value>
```

## Quick fix

Convert to bounds (with the unit converted to SI when one is given). Quick fixes are proposals: they are op batches that pass the grounding gate and are never applied automatically.

## Suppressing

Add a suppression with a reason for `IDSL-VAL-004` (or `IDSL-VAL-*`) to the node, its facet, its specification or the document in the Studio sidecar (`meta.suppressions`).

[All lint rules](index.md)

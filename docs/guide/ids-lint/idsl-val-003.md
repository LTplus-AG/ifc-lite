<!-- Generated from the rule metadata in packages/ids-authoring/src/lint/rules by packages/ids-authoring/scripts/generate-lint-docs.mjs. Do not edit by hand. -->

# IDSL-VAL-003: Simple value that looks like a list

| Default severity | Kind | Scope | Quick fix |
|---|---|---|---|
| warning | static | specification | yes |

A simple value is compared as one exact string. "EI60, EI90", "[EI60, EI90]" or "EI60/EI90" therefore only matches elements carrying that whole text, never EI60 or EI90 alone. Alternatives are written as an enumeration.

## Example

```xml
<value><simpleValue>EI60, EI90</simpleValue></value>
```

## Quick fix

Convert to an enumeration of the items. Quick fixes are proposals: they are op batches that pass the grounding gate and are never applied automatically.

## Suppressing

Add a suppression with a reason for `IDSL-VAL-003` (or `IDSL-VAL-*`) to the node, its facet, its specification or the document in the Studio sidecar (`meta.suppressions`).

[All lint rules](index.md)

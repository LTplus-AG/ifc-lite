<!-- Generated from the rule metadata in packages/ids-authoring/src/lint/rules by packages/ids-authoring/scripts/generate-lint-docs.mjs. Do not edit by hand. -->

# IDSL-ATT-002: Value check on an entity-typed attribute

| Default severity | Kind | Scope | Quick fix |
|---|---|---|---|
| warning | static | specification | yes |

The attribute holds a reference to another entity (for example ObjectPlacement or OwnerHistory), not a simple value, so a value constraint on it cannot match. Only its existence can be checked.

## Example

```xml
<attribute><name><simpleValue>ObjectPlacement</simpleValue></name><value><simpleValue>x</simpleValue></value></attribute>
```

## Quick fix

Remove the value so the facet checks existence only. Quick fixes are proposals: they are op batches that pass the grounding gate and are never applied automatically.

## Suppressing

Add a suppression with a reason for `IDSL-ATT-002` (or `IDSL-ATT-*`) to the node, its facet, its specification or the document in the Studio sidecar (`meta.suppressions`).

[All lint rules](index.md)

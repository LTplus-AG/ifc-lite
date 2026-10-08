<!-- Generated from the rule metadata in packages/ids-authoring/src/lint/rules by packages/ids-authoring/scripts/generate-lint-docs.mjs. Do not edit by hand. -->

# IDSL-ATT-001: Attribute not defined on the entity

| Default severity | Kind | Scope | Quick fix |
|---|---|---|---|
| error | static | specification | yes |

The attribute does not exist on any applicability entity, including inherited attributes, so an attribute requirement always fails and an attribute applicability selects nothing. Attribute names are the EXPRESS names (Name, Description, ObjectType, Tag, …).

## Example

```xml
<entity><name><simpleValue>IFCWALL</simpleValue></name></entity> + <attribute><name><simpleValue>Nmae</simpleValue></name></attribute>
```

## Quick fix

Replace it by the closest attribute of the entity. Quick fixes are proposals: they are op batches that pass the grounding gate and are never applied automatically.

## Suppressing

Add a suppression with a reason for `IDSL-ATT-001` (or `IDSL-ATT-*`) to the node, its facet, its specification or the document in the Studio sidecar (`meta.suppressions`).

[All lint rules](index.md)

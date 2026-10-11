<!-- Generated from the rule metadata in packages/ids-authoring/src/lint/rules by packages/ids-authoring/scripts/generate-lint-docs.mjs. Do not edit by hand. -->

# IDSL-ENT-004: Type entity where an occurrence is meant

| Default severity | Kind | Scope | Quick fix |
|---|---|---|---|
| warning | static | specification | yes |

The applicability selects a type object (an IfcTypeObject subtype such as IfcDoorType) but the specification also uses a spatial containment, voiding or filling relation. Type objects are never contained in a storey, voided or filled; only occurrences are. Note that occurrences inherit the properties of their type, so checking the occurrence also covers type-level properties.

## Example

```xml
<entity><name><simpleValue>IFCDOORTYPE</simpleValue></name></entity> + <partOf relation="IFCRELCONTAINEDINSPATIALSTRUCTURE">
```

## Quick fix

Switch the applicability to the occurrence class. Quick fixes are proposals: they are op batches that pass the grounding gate and are never applied automatically.

## Suppressing

Add a suppression with a reason for `IDSL-ENT-004` (or `IDSL-ENT-*`) to the node, its facet, its specification or the document in the Studio sidecar (`meta.suppressions`).

[All lint rules](index.md)

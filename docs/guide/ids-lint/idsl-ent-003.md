<!-- Generated from the rule metadata in packages/ids-authoring/src/lint/rules by packages/ids-authoring/scripts/generate-lint-docs.mjs. Do not edit by hand. -->

# IDSL-ENT-003: Entity has subtypes the author may also mean

| Default severity | Kind | Scope | Quick fix |
|---|---|---|---|
| info | static | specification | yes |

An applicability entity matches only that exact class. Concrete subtypes (IfcWallStandardCase and IfcWallElementedCase for IfcWall in IFC4, IfcSlabStandardCase for IfcSlab, …) are not selected unless listed. This is often intended, but frequently it is not.

## Example

```xml
<applicability><entity><name><simpleValue>IFCWALL</simpleValue></name></entity></applicability> (IFC4)
```

## Quick fix

Add the concrete subtypes to the entity enumeration. Quick fixes are proposals: they are op batches that pass the grounding gate and are never applied automatically.

## Suppressing

Add a suppression with a reason for `IDSL-ENT-003` (or `IDSL-ENT-*`) to the node, its facet, its specification or the document in the Studio sidecar (`meta.suppressions`).

[All lint rules](index.md)

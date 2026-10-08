<!-- Generated from the rule metadata in packages/ids-authoring/src/lint/rules by packages/ids-authoring/scripts/generate-lint-docs.mjs. Do not edit by hand. -->

# IDSL-PART-001: Unlikely partOf relation for these entities

| Default severity | Kind | Scope | Quick fix |
|---|---|---|---|
| info | static | specification | yes |

The relation is allowed by the schema but unusual for these entities. Building elements are placed in a storey or space by spatial containment (IfcRelContainedInSpatialStructure), not aggregation; spatial elements (sites, buildings, storeys) are decomposed by aggregation (IfcRelAggregates), not containment. The audit already rejects combinations the schema forbids.

## Example

```xml
<entity>IFCWALL</entity> + <partOf relation="IFCRELAGGREGATES"><entity>IFCBUILDINGSTOREY</entity></partOf>
```

## Quick fix

Use the usual relation. Quick fixes are proposals: they are op batches that pass the grounding gate and are never applied automatically.

## Suppressing

Add a suppression with a reason for `IDSL-PART-001` (or `IDSL-PART-*`) to the node, its facet, its specification or the document in the Studio sidecar (`meta.suppressions`).

[All lint rules](index.md)

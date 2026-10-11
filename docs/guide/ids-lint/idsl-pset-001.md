<!-- Generated from the rule metadata in packages/ids-authoring/src/lint/rules by packages/ids-authoring/scripts/generate-lint-docs.mjs. Do not edit by hand. -->

# IDSL-PSET-001: Standard property set not applicable to the entity

| Default severity | Kind | Scope | Quick fix |
|---|---|---|---|
| warning | static | specification | yes |

The standard property set is not defined for any applicability entity (per its applicable entities, including subtypes and companion type objects). Authoring tools will not offer it on those elements, so the requirement is likely to fail on every model. The audit reports the same mismatch; lint adds the applicable alternatives.

## Example

```xml
<entity><name><simpleValue>IFCDOOR</simpleValue></name></entity> + <property><propertySet><simpleValue>Pset_WallCommon</simpleValue></propertySet>…
```

## Quick fix

Switch to an applicable standard set that defines the same property. Quick fixes are proposals: they are op batches that pass the grounding gate and are never applied automatically.

## Suppressing

Add a suppression with a reason for `IDSL-PSET-001` (or `IDSL-PSET-*`) to the node, its facet, its specification or the document in the Studio sidecar (`meta.suppressions`).

[All lint rules](index.md)

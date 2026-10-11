<!-- Generated from the rule metadata in packages/ids-authoring/src/lint/rules by packages/ids-authoring/scripts/generate-lint-docs.mjs. Do not edit by hand. -->

# IDSL-ENT-002: Entity removed in IFC4X3

| Default severity | Kind | Scope | Quick fix |
|---|---|---|---|
| info | static | specification | yes |

The entity exists in the IFC versions this specification targets but was removed in IFC4X3 (for example IfcWallElementedCase or IfcBeamStandardCase, whose instances are plain IfcWall / IfcBeam in IFC4X3). Requirements written against it will not carry over when the specification is retargeted.

## Example

```xml
<specification ifcVersion="IFC4"> … <entity><name><simpleValue>IFCBEAMSTANDARDCASE</simpleValue></name></entity>
```

## Quick fix

Also match the IFC4X3 replacement (the parent class), keeping the original name so older models still match. Quick fixes are proposals: they are op batches that pass the grounding gate and are never applied automatically.

## Suppressing

Add a suppression with a reason for `IDSL-ENT-002` (or `IDSL-ENT-*`) to the node, its facet, its specification or the document in the Studio sidecar (`meta.suppressions`).

[All lint rules](index.md)

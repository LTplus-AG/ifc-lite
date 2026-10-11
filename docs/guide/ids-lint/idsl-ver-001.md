<!-- Generated from the rule metadata in packages/ids-authoring/src/lint/rules by packages/ids-authoring/scripts/generate-lint-docs.mjs. Do not edit by hand. -->

# IDSL-VER-001: Name valid in only some IFC versions of the specification

| Default severity | Kind | Scope | Quick fix |
|---|---|---|---|
| warning | static | specification | yes |

A specification that lists several IFC versions must use names (entities, attributes, standard sets and properties) that exist in each of them. A name missing from one version makes the specification fail or select nothing on models of that version. IFC4 class names that the IFC2X3 occurrence/type mapping table resolves (IfcAirTerminal, …) are accepted for IFC2X3.

## Example

```xml
<specification ifcVersion="IFC2X3 IFC4"> … <entity><name><simpleValue>IFCBUILDINGSYSTEM</simpleValue></name></entity>
```

## Quick fix

Restrict the specification to the versions in which every name exists. Quick fixes are proposals: they are op batches that pass the grounding gate and are never applied automatically.

## Suppressing

Add a suppression with a reason for `IDSL-VER-001` (or `IDSL-VER-*`) to the node, its facet, its specification or the document in the Studio sidecar (`meta.suppressions`).

[All lint rules](index.md)

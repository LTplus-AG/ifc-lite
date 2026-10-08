<!-- Generated from the rule metadata in packages/ids-authoring/src/lint/rules by packages/ids-authoring/scripts/generate-lint-docs.mjs. Do not edit by hand. -->

# IDSL-UNIT-001: Magnitude suggests a non-SI unit

| Default severity | Kind | Scope | Quick fix |
|---|---|---|---|
| warning | static | specification | yes |

IDS values are in SI units: metres, square metres, cubic metres. A door height of 2400 or a wall thickness of 240 is almost certainly in millimetres and will never match a model, which stores 2.4 and 0.24 in IDS terms. Thresholds: lengths from 1000 (from 100 for Height, Width, Depth, Thickness, Diameter, Radius), areas from 1e6, volumes from 1e9.

## Example

```xml
<property dataType="IFCLENGTHMEASURE">…<baseName><simpleValue>Height</simpleValue></baseName><value><simpleValue>2400</simpleValue></value></property>
```

## Quick fix

Convert the value from millimetres to SI. Quick fixes are proposals: they are op batches that pass the grounding gate and are never applied automatically.

## Suppressing

Add a suppression with a reason for `IDSL-UNIT-001` (or `IDSL-UNIT-*`) to the node, its facet, its specification or the document in the Studio sidecar (`meta.suppressions`).

[All lint rules](index.md)

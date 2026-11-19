---
"@ifc-lite/export": minor
"@ifc-lite/viewer": patch
---

`MergeModelInput` takes an optional `georefMutations`, and `MergedExporter.exportAsync` bakes it like single-model export does, so a merged STEP export keeps a model's IfcProjectedCRS and IfcMapConversion edits. The viewer's merged export and the `exports.mergedStep` agent operation now pass them.

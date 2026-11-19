---
"@ifc-lite/export": minor
"@ifc-lite/viewer": patch
---

`MergeModelInput` takes an optional `georefMutations`, and `MergedExporter.exportAsync` bakes it like single-model export does, so a merged STEP export keeps a model's IfcProjectedCRS and IfcMapConversion edits. An edit the exporter refuses, or that an IFC2X3 target cannot hold, is left out and named in `stats.warnings`. New `isGeorefRefusal(error)` tells that refusal apart from a real export failure. The viewer's merged export and the `exports.mergedStep` agent operation now pass the edits.

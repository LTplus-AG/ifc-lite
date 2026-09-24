---
"@ifc-lite/create": major
---

Remove `ProjectParams.FileSchemaIdentifier` (#5562). It has done nothing since #5351: `IfcCreator` declares every IFC4X3 file as `FILE_SCHEMA(('IFC4X3_ADD2'))` on its own. The only thing it still did was throw when combined with a `Schema` other than `'IFC4X3'`. Callers just delete the option; the output does not change.

---
"@ifc-lite/export": minor
"@ifc-lite/flow-nodes": patch
---

XLSX exports respect Excel's limits: sheet names are sanitised (illegal characters, 31 characters, case-insensitive uniqueness) instead of making the export throw, and cells over 32,767 characters are truncated with an ellipsis instead of producing a file Excel offers to repair.

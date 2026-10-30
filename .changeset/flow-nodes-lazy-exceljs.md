---
"@ifc-lite/flow-nodes": patch
---

`readXlsxTable` and `writeXlsxTable` load `exceljs` when they are called instead of when the package is imported, so importing `@ifc-lite/flow-nodes` no longer runs all of `exceljs`.

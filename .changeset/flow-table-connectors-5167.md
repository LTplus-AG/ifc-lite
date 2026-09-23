---
"@ifc-lite/flow-nodes": minor
---

Add the spreadsheet connector nodes for the flow-graph pilot workflow (issue #5167 phase 3.2): `table.readCsv`, `table.writeCsv`, `table.readXlsx`, `table.writeXlsx`, `table.joinByKey` (GlobalId/Tag/Name/indexed-property matching, with matched/unmatched/ambiguous outputs — ambiguity is reported, never resolved to the first match), and `model.applyTable` (typed columns to property mutations through the existing `bim.mutate` write path; a cell that does not parse as its column's declared type is reported per row and not written). `table.joinByKey`'s `tag`/`property` strategies reuse `@ifc-lite/mutations`' `csv-match.ts` index builder rather than re-implementing matching, through a new optional `FlowHost.tables()` accessor (`TableAccess`). `readXlsxTable`/`writeXlsxTable` are exported as a shared `exceljs`-backed module usable by both the CLI and the viewer.

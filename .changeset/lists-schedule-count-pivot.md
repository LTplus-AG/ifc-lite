---
'@ifc-lite/lists': minor
---

Add `toScheduleRows()`: project a grouped `ListResult` down to a Bonsai-style
schedule / pivot presentation — one row per group-value tuple (leaf group),
carrying its Count aggregate and configured sums as first-class fields,
instead of the nested tree `ListGroup[]` already returned.

Follow-up to the multi-criteria grouping added for issue #1790: the reporter
came back asking for Count as its own column (not a badge next to the group
label) and a pivot/schedule table (grouping columns become leading columns,
one row per combination) matching Bonsai's own output — plus a CSV export
that mirrors that arrangement.

`ListGrouping` gains an optional `view?: 'nested' | 'schedule'` field
(`undefined` keeps the existing nested-tree behaviour, so persisted lists are
unaffected) and a new `ListScheduleRow` type describes each schedule row.
The viewer's Lists panel and its CSV/XLSX/PDF export now offer a schedule
(pivot) view alongside the existing nested tree.

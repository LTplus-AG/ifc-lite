---
"@ifc-lite/lists": minor
---

Count aggregation with multi-criteria grouping in lists (issue #1790): `ListGrouping.columnIds` groups rows by several columns in order (e.g. Building, then Storey); `summariseListRows` emits a flat pre-order group list with `level`/`path` and a per-group `count` (the Count aggregate) plus per-column sums at every nesting level. New helpers: `groupingColumnIds` resolves the effective group columns with full backward compatibility for the legacy single `columnId`, and `groupPathKey` encodes a group path into its collision-free unique key (`ListGroup.key` is now this JSON path encoding).

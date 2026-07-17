---
"@ifc-lite/lists": minor
---

Count aggregation with multi-criteria grouping in lists (issue #1790): `ListGrouping.columnIds` groups rows by several columns in order (e.g. Building, then Storey); `summariseListRows` emits a flat pre-order group list with `level`/`path` and a per-group `count` (the Count aggregate) plus per-column sums at every nesting level. New `groupingColumnIds` helper resolves the effective group columns with full backward compatibility for the legacy single `columnId`.

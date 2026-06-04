---
"@ifc-lite/lists": minor
---

Add counts, sums, and grouping to list results (#926).

`ListDefinition.grouping` ({ columnId, sumColumnIds }) makes `executeList`
return a per-group breakdown (`ListResult.groups` — label, element count,
per-column sums) plus a whole-result `summary` (count + sums). Group by any
column (type, material, classification, storey, property value) and total
numeric columns per group and overall.

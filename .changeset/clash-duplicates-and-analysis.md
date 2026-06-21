---
"@ifc-lite/clash": minor
---

Add duplicate / overlapping-element detection and result-analysis helpers.

`findDuplicates(elements)` runs a cheap AABB + triangle-count pass (uniform hash
grid, no narrow phase) to flag accidentally duplicated or coincident objects —
the first thing reviewers look for in a single discipline model (#1280). It
returns a normal `ClashResult` (rule id `duplicates`) so the panel, grouping and
BCF export render it with no special-casing.

New pure helpers in `analysis.ts`: `penetrationDepth`, `isTouching` (identify
zero-distance face/edge contacts, #1273), `sortClashes` by severity / overlap
depth / signed distance (#1274), and `SEVERITY_RANK`.

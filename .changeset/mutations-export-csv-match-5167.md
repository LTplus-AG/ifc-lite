---
"@ifc-lite/mutations": minor
---

Export `buildMatchContext`/`matchRowAgainstContext` (from `csv-match.ts`) and `parseValue`/`PARSE_INVALID` (from `csv-parse-value.ts`) so `@ifc-lite/flow-nodes`' `table.joinByKey` (issue #5167 phase 3.2) can reuse the existing tag/property row-matching index and typed-cell parsing instead of re-implementing them.

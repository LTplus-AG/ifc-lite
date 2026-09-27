---
"@ifc-lite/mutations": major
"@ifc-lite/rules": minor
---

Remove `BulkQueryEngine` property predicates and their legacy typed-operator adapters. Use `@ifc-lite/rules` `FilterGroup[]` with `evaluateFilterGroupsFederated` to obtain model-scoped Express IDs, then pass those IDs in `BulkQueryEngine` `select.expressIds`. The Bulk engine constructor no longer accepts a PropertyTable fourth argument; shift later arguments left. The viewer Bulk editor now uses the Rules filter builder and evaluator.

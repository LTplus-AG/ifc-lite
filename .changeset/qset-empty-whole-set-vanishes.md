---
"@ifc-lite/mutations": patch
---

Fix `changeSetToOps` silently dropping a whole quantity set created with zero quantities (`createQuantitySet(entity, name, [])`, e.g. `StoreEditor.addQuantitySet` called before any quantity is added).

The whole-qset `CREATE_QUANTITY` branch (added in #2263 for the non-empty case) looped over `newValue` to populate the published component's `values`, but never first materialized the component the way the sibling `CREATE_PROPERTY_SET` branch does. An empty `newValue` array meant the loop ran zero times, so the component was never added to the fold at all — the mutation matched the `CREATE_QUANTITY` case (so it never reached the `default` branch that records unrepresentable mutations either), and the set vanished from the published layer with `ops: []` and `skipped: []`: no diagnostic, no trace. Same failure shape as #2263, in the one corner (empty array) that fix's test coverage didn't reach.

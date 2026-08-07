---
"@ifc-lite/query": patch
---

Fix `EntityQuery.first()` permanently capping the query it was called on. `first()` narrowed the result set by calling `this.limit(1)` — which mutates the query object itself rather than a clone — so the cap outlived the call: every subsequent `execute()`, `ids()` or `first()` on the same query returned at most one row. A caller's own explicit `limit(n)` was overwritten too, silently collapsing to 1.

Building a query, peeking at the first match, then iterating it in full is ordinary usage of a fluent query API, and `EntityQuery` is published surface — so "no in-repo caller does that" is not a defence here, the same reasoning applied to `ParquetExporter`'s un-memoised overlay index in the #2111 review.

`first()` now narrows for the duration of the call only, restoring whatever limit was previously set rather than clearing it.

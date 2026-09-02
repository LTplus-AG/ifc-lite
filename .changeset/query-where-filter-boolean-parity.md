---
'@ifc-lite/query': minor
---

Add `compareFilterValue`/`normalizeBooleanValue`/`findAllPropertiesInSets` (and the `FilterComparisonOp` type), the shared implementation of the `QueryDescriptor.filters` comparison the CLI (`HeadlessBackend`), MCP, and `ifc-lite query --where` backends each carried a private copy of. The viewer's embedded SDK backend — the one behind `bim.query().where(...)` in sandbox/playground scripts, the SDK's primary consumption path — never picked up the boolean-normalization or case-insensitive-`contains` fix the other backends have independently landed, so an identical `where()` call could silently match a different result set depending on which host ran the script. That backend now uses this shared function, and the CLI/MCP backends were switched to it too so the four implementations can't drift apart again.

Public `where()`/`--where` behaviour is unchanged by this unification:
- `exists` still matches as soon as the property/quantity is found, regardless of its value — an `IFCPROPERTYSINGLEVALUE('FireRating',$,$,$)` (a `$` nominal value, parsed as `null`) is present in its pset and must match `exists`, the same as before this refactor.
- A `where()` filter on any operator still matches when ANY same-named property set carries a satisfying value, not just the first one found (#3490) — an entity can legitimately carry two same-named psets (e.g. type + occurrence).

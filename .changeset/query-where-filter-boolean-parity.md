---
'@ifc-lite/query': minor
---

Add `compareFilterValue`/`normalizeBooleanValue` (and the `FilterComparisonOp` type), the shared implementation of the `QueryDescriptor.filters` comparison the CLI (`HeadlessBackend`), MCP, and `ifc-lite query --where` backends each carried a private copy of. The viewer's embedded SDK backend — the one behind `bim.query().where(...)` in sandbox/playground scripts, the SDK's primary consumption path — never picked up the boolean-normalization or case-insensitive-`contains` fix the other backends have independently landed, so an identical `where()` call could silently match a different result set depending on which host ran the script. That backend now uses this shared function, and the CLI/MCP backends were switched to it too so the four implementations can't drift apart again.

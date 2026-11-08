---
"@ifc-lite/cache": patch
---

`FORMAT_VERSION` moves 25 → 26, so a model cached before the relationship reader fix (#9192) re-parses once. The bytes are unchanged, but a v25 entry may hold a relationship graph with a misread edge: `IFCRELDEFINESBYTYPE(…,((#10),#14),#40)` was stored as "#14 types #10". The parser now records no edges for such a record, and the type-quantities read no longer checks edges for it, so an old graph would be trusted as it stands. The viewer's cache key carries `FORMAT_VERSION`, so v25 entries miss and are rebuilt.

---
"@ifc-lite/cache": patch
"@ifc-lite/data": patch
"@ifc-lite/parser": patch
---

A cache hit no longer builds the relationship graph's `offsets`/`counts` Maps while it decodes. The node table stays as typed arrays: lookups binary-search it, and the Maps are built (identically, in the same order) the first time a consumer reads them. A table that is not strictly ascending keeps the eager Maps. `RelationshipEdges.nodeIds()` (optional) lists the node ids without building the Maps; the spatial hierarchy's canonical-parent pass uses it.

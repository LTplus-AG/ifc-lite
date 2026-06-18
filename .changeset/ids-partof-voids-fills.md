---
"@ifc-lite/ids": patch
"@ifc-lite/data": patch
---

Accept the IDS `partOf` facet's merged voids/fills relation. The IDS XSD
enumerates `IFCRELVOIDSELEMENT IFCRELFILLSELEMENT` as a single
space-separated token (the two relations were merged upstream), but it was
flagged as an invalid relation on import and silently collapsed to
voids-only. It is now recognised end-to-end: the parser preserves the
combined relation, the schema auditor accepts it, and the ancestor walk
follows both the fills and voids edges so an element reaches its host
building element through the opening. Fixes #1205.

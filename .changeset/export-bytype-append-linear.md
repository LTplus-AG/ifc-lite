---
"@ifc-lite/export": patch
---

Exporting a model with many entities created this session no longer slows down quadratically. The effective type index copied a type's whole id list for every created entity of that type, so 100,000 created annotations took about 26 seconds to index before export; it now copies each list once.

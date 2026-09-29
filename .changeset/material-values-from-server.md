---
"@ifc-lite/parser": patch
"@ifc-lite/server-client": patch
"@ifc-lite/ids": patch
"@ifc-lite/viewer": patch
---

Preserve IFC material associations forwarded by the server, including their names, categories, and definition identities, so models parsed by the server can evaluate material values without mistaking partial legacy payloads for verified mismatches.

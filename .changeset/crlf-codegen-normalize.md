---
"@ifc-lite/codegen": patch
---

Normalize CRLF/lone-CR line endings before parsing an EXPRESS `.exp` schema, so a schema fetched or generated fresh on Windows no longer leaks a stray `\r` into the generated TypeScript output (which breaks `tsc` on the emitted code).

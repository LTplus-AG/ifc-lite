---
"@ifc-lite/parser": patch
---

Reject wasm source scans at the exclusive 2 GiB boundary and reject compact entity byte spans that cannot fit uint32. Export the shared source-size guard for browser consumers.

---
"@ifc-lite/geometry": minor
"@ifc-lite/server-client": patch
"@ifc-lite/wasm": minor
---

Version geometry diagnostics as schema 6 when silent rectangular cuts are measured by surface area and volume. Older payloads retain their triangle-count semantics. When a browser load combines diagnostic batches from both versions, only measured batches contribute to the schema 6 count. The WASM pipeline diagnostics report publishes the same measured count as schema 2.

---
"@ifc-lite/export": patch
"@ifc-lite/wasm": patch
---

Refuse Rust/WASM and TypeScript STEP export before output when canonical scanning reports dropped malformed records, instead of silently exporting an incomplete index. Valid doubled-apostrophe sources and lower-level raw-line edit refusals retain their behavior.

Invalidate older viewer cache output policy once so a previously cached partial index cannot bypass the corrected scanner on reload; preserve the cache binary format and original entries.

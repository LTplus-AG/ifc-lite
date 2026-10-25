---
"@ifc-lite/wasm": patch
---

Match the JavaScript runtime's Unicode class normalization in raw DiffModel comparisons, including Node 22's older tables, while retaining lossless UTF-16 and original host exception identity. Native Rust normalization and published JavaScript signatures are unchanged.

---
"@ifc-lite/wasm": patch
---

Accept IFC files containing non-UTF-8 string bytes in raw-byte scanning,
pre-pass, and geometry processing APIs instead of rejecting or sanitizing the
entire file.

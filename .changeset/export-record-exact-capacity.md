---
"@ifc-lite/wasm": patch
---

Rust-only: `ifc-lite-export` builds each new STEP record in a buffer sized to the record. The records were built with `format!`, whose doubling growth left records of a few hundred bytes and up holding 1.98 to 2.00 times their length in memory, and an export keeps every record it builds. Output bytes are unchanged.

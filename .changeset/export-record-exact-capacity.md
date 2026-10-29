---
"@ifc-lite/wasm": patch
---

Rust-only: in `ifc-lite-export`, records added by an export plan through `build_record` and `build_value_record` are now built in a buffer sized to the record. The records were built with `format!`, whose doubling growth left records of a few hundred bytes and up holding 1.98 to 2.00 times their length in memory, and an export keeps every such record until it writes the file. Output bytes are unchanged.

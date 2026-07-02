---
"@ifc-lite/wasm": patch
---

Quantized GLB exports now route through the bounded streaming assembler above the 64 MB threshold too (byte-identical to the in-memory quantized layout on models without instanceable groups), and the wasm crate is clippy-clean: the dead colour/parse-event/JS-helper functions were removed and the remaining mechanical warnings fixed.

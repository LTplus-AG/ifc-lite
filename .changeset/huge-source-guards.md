---
"@ifc-lite/parser": minor
---

Add the public `WASM_SOURCE_BYTE_LIMIT`, `WasmSourceSizeError` and `assertWasmSourceSize` API so browser consumers can refuse whole-source allocations at the exclusive 2 GiB boundary before copying the source.

Tighten the WASM byte-scan eligibility gate from 2.5 billion bytes to that same boundary: sources at or above 2 GiB now select the existing JS tokenizer fallback instead of attempting a WASM scan that cannot succeed. This does not impose a new source-size rejection on the parser itself. Compact entity index builders now throw `RangeError` for byte offsets or lengths outside uint32 instead of silently wrapping them.

---
"@ifc-lite/wasm": minor
---

Accept IFC files that contain non-UTF-8 string bytes instead of rejecting or
sanitizing the whole file (fixes #1023).

Raw-byte scanning, the pre-pass, and geometry-processing APIs now operate on
byte slices, so files exported by BIM tools with Latin-1/Windows-1252
characters (e.g. `é`, `ä`, `°`) load instead of erroring out. Invalid bytes are
decoded lossily per field — only the affected string is touched — and the
original raw bytes are preserved for callers that want to re-decode them. No
full-file UTF-8 validation is performed, so large/memory-mapped files are not
penalized.

Note for Rust crate consumers — this is a breaking change to the
`ifc-lite-core` public API: `EntityScanner`, `EntityDecoder`,
`build_entity_index`, `parse_entity`, and `parse_stream` now accept
`T: AsRef<[u8]> + ?Sized` (e.g. `&[u8]`, `&str`, `Vec<u8>`, mmap buffers)
instead of `&str`. Existing `&str` callers continue to compile; code that
relied on the input being `&str` should switch to byte slices.

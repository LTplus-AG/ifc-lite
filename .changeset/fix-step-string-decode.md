---
"@ifc-lite/encoding": patch
---

fix(encoding): stop `\S\` decoding from diverging / panicking on multi-byte input

The `\S\C` STEP escape (code point of `C` plus 128) is spec-defined for a single
ASCII `C`, but a malformed-but-UTF-8 file can put a multi-byte `C` there.
`decodeIfcString` now reads `C` as a whole code point (advancing past a surrogate
pair) instead of one UTF-16 unit, so it no longer leaves a dangling surrogate and
stays in parity with the Rust `decode_ifc_string`, whose matching fix also stops
a multi-byte `C` from panicking mid-slice (which aborts the wasm instance). Pinned
by a new non-BMP `\S\` case in the shared `ifc_string_vectors.json` fixture.

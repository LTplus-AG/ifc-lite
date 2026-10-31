---
"@ifc-lite/server-bin": patch
"@ifc-lite/wasm": patch
---

`ifc-lite-processing` adds `ParseResponse::from_result`, the single mapping from a `ProcessingResult` to the serialised parse response (#8341). The FFI DLL and the server's `POST /api/v1/parse` now both build on it. The server still adds Y-up meshes, IFC-authored finishes and symbolic data with provenance on top. The FFI buffer is unchanged byte for byte: it still carries no finishes, and a pinned test now checks that.

---
"@ifc-lite/wasm": patch
---

Rust-only presentation and glTF export additions (#7955). The native exporter can emit canonical UVs and PNG-backed textures when requested; the default browser engine keeps the texture encoder out. New public `MeshData` and `ExportError` members require Rust major 23, recorded in `rust-major-offset.json`. The npm-facing WASM API is unchanged.

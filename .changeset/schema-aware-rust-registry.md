---
'@ifc-lite/codegen': patch
'@ifc-lite/wasm': patch
---

Generate crate-private IFC2X3 and IFC4 Rust registries alongside the canonical IFC4X3 registry. Exported entity attributes now use the source file's declared schema for positional names, while retaining metadata for transitional entities absent from the bundled EXPRESS inputs.

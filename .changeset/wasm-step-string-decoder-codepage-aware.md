---
'@ifc-lite/wasm': patch
---

Fix the bundled Rust STEP string decoder's `\S\` escape to honor the `\P?\` code page a string literal selects (ISO 10303-21 6.4.3), instead of always treating the result as ISO 8859-1. See the `@ifc-lite/encoding` changeset in this release for the full description — `ifc_lite_core::decode_ifc_string` had the identical bug as its TypeScript counterpart and is fixed the same way, with both pinned to the same shared code-page test vectors.

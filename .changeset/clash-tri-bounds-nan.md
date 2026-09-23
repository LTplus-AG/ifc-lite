---
"@ifc-lite/wasm": patch
---

The Rust clash kernel's per-triangle bounds now propagate a NaN vertex the way the TypeScript kernel does. Before, it built finite bounds from the triangle's other two vertices, so a corrupted triangle stayed queryable in the WASM backend while the TypeScript backend excluded it.

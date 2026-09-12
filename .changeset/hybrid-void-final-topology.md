---
"@ifc-lite/wasm": patch
---

Keep mixed 2D and exact-kernel opening subtraction from returning a catastrophically torn final mesh. The final hybrid composition is now checked after residual cutters are applied; material tears fall back only when the full-context result has less than half as many non-manifold edges, preserving established small-tear and triangulator-invariant results.

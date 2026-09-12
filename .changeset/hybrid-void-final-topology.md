---
"@ifc-lite/wasm": patch
---

Keep mixed 2D and residual opening subtraction from returning a catastrophically torn final mesh. The final hybrid composition is now checked after residual cutters are applied; material tears use full-context routing only when it produces less than half as many non-manifold edges, preserving established small-tear and triangulator-invariant results.

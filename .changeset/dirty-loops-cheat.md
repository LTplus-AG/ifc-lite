---
"@ifc-lite/wasm": patch
---

Recover omitted slab cap boundaries when a finite, positive local face collapses or reverses on conversion to mesh coordinates. The bounded constrained triangulation preserves original profile vertices and requires a complete cap with representable faces; ordinary representable triangulations retain their established output (#7631).

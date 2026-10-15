---
"@ifc-lite/wasm": patch
---

Preserve slab profile boundaries when triangulating caps with multiple holes. When ear clipping omits a boundary, a validated constrained triangulation can recover it using the original profile vertices, keeping caps closed against their side walls (#7631).

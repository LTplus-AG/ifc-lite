---
"@ifc-lite/geometry": patch
---

Preserve remeshing panic source locations across the worker boundary (#6555), including when cleanup also traps. Consume cleanup locations so a later request cannot inherit them. Forward only Rust source location and timestamp, without model-derived panic text.

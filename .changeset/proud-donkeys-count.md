---
"@ifc-lite/renderer": patch
---

Reuse textured geometry buffers in the selection highlight and outline passes, avoiding copied highlight geometry and pooling per-draw uniforms while preserving selection appearance and draw order.

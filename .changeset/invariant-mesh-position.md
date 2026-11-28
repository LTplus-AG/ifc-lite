---
"@ifc-lite/renderer": patch
---

The mesh vertex stages now declare their clip position `@invariant`. The selection highlight and its masks redraw a surface over depth written by another shader module (the draw stream, the discard-free opaque twin, the orthographic prepass), with `greater-equal` and no bias. That needs bit-identical positions, which WGSL guarantees across modules only for an invariant position. On Apple GPUs with the draw stream on, the highlight of a selected element showed its base colour through in blocky patches that moved with the camera.

---
"@ifc-lite/renderer": patch
---

Keep the selection and hover highlight solid on small or far elements: a batch holding a highlighted entity now draws its full-detail triangles, never its LOD1 indices or an HLOD proxy, so the highlight's redraw ties with it. A highlight copy built mid-stream also follows the encoding of the streaming fragment that draws it, so an f32 fragment's copy is no longer snapped to the quantization lattice.

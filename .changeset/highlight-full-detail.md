---
"@ifc-lite/renderer": patch
---

Keep the selection and hover highlight solid on small or far elements: a batch holding a highlighted entity now draws its full-detail triangles, never its LOD1 indices or an HLOD proxy, so the highlight's redraw ties with it (`FrameStats.batchesFullDetail` counts those batches). A highlight copy built mid-stream follows the encoding of the streaming fragment that draws it, and a copy whose piece moves into another frame or encoding (a finalize swapping its fragment for an f32 bucket) is built again, so neither sits half a lattice step off its base.

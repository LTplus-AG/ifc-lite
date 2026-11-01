---
"@ifc-lite/renderer": minor
---

Opaque draws that nothing can clip or hide now use a fragment shader without `discard`, so the GPU can reject hidden fragments before shading them. Opaque batches draw nearest first, and the object-id target is not written on frames where edges are off. The GPU picker allocates its targets on the first GPU pick instead of at startup, and selection-outline targets are freed after a run of frames with nothing selected or hovered. New `Renderer.getRenderTargetBytes()` reports the render-target memory the renderer holds.

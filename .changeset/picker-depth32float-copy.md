---
"@ifc-lite/renderer": patch
---

Fix GPU picker silently failing on small models. `Picker.pick()` was
reading back a 1×1 `depth-only` texel for click-to-world unprojection,
which WebGPU rejects — depth/stencil-format copies must cover the full
subresource. Clicks on files small enough to take the GPU picker path
(≤500 mesh pieces; larger models hit the CPU-raycast fallback) silently
resolved to `null`, leaving no 3D highlight and no property panel. The
depth readback now copies the full depth image and indexes the mapped
buffer client-side; no shader, pipeline, or point-picker changes.

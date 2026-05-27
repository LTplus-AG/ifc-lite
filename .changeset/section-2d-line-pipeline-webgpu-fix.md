---
"@ifc-lite/renderer": patch
---

Fix invalid WebGPU pipeline error on the 2D section overlay line pipeline.
After #812 the line pipeline carried `depthBias` / `depthBiasSlopeScale` /
`depthBiasClamp` alongside `topology: 'line-list'`, which the WebGPU spec
rejects ("Depth bias is not compatible with non-triangle topology
LineList"). The invalid pipeline then surfaced a second error on every
`set_pipeline` for section cut outlines and 3D annotation lines.

The depth-bias fields are removed from the pipeline and the equivalent
reverse-Z decal nudge is now applied directly in the line vertex shader
(`clip.z + 5e-5 * clip.w`), preserving the #812 coplanar-line fix while
producing a valid WebGPU pipeline.

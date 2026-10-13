---
"@ifc-lite/renderer": patch
---

Selecting or hovering an element with an IFC surface texture now tints it solidly instead of z-fighting the texture in patches (#7503). The highlight copy was built in the model's colour-batch frame, but textured geometry draws its raw positions against its own origin and is never quantized, so the copy landed a few f32 ulps off the surface it covers. Highlight and hover copies of textured pieces are now built in the textured drawable's own frame and are bit-coincident with it.

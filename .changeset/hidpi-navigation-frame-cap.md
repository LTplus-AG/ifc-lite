---
"@ifc-lite/renderer": minor
---

Add a frame-local RenderOptions.maxPixelRatio cap that preserves the renderer's persistent resolution preference for subsequent idle and capture renders.

Add Renderer.renderWithResult on the shared render path so captures can reject skipped or contained-failure frames before reading the canvas. Preserve the existing void Renderer.render contract.

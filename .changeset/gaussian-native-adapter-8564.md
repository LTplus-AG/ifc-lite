---
"@ifc-lite/renderer": minor
---

Add an internal, unqualified Gaussian splat adapter, `Renderer.gaussianSplats`, that draws upstream luma.gl splats on the renderer's own WebGPU device and frame. `add()` requires `{ qualification: 'internal-unqualified' }`; `getGaussianReadiness()` stays `blocked` and now also lists the adapter's `capabilities`. Exports the adapter's handle, placement, state, bounds and error types.

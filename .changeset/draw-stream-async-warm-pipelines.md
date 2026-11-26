---
"@ifc-lite/renderer": patch
---

Draw stream: prewarming the other discard mode no longer compiles its pipelines synchronously mid-navigation. They now build with `createRenderPipelineAsync`, and prewarm records that mode only once they are ready. Before this, the first orbit with bundles blocked the GPU process for about 113 ms of shader compilation, which showed up as one 120 ms frame.

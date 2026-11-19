---
"@ifc-lite/drawing-2d": minor
---

Draw from streamed geometry (#10264):

- `Drawing2DGenerator.generateFromSource(source, config, options, profiles?)` draws from a `DrawingMeshSource`, a replayable source of mesh batches. It reads at most two passes: `'geometry'`, and `'occlusion'` only when hidden lines or an open surface need it. It keeps no mesh between batches, so a source can lease each batch from storage and release it when the generator moves on. The drawing equals `generate` over the same meshes, and `generate` now runs on the same code. `GeneratorOptions.signal` aborts between batches.
- `StoreyFloorLevels` computes `storeyFloorsFromMeshes` one batch at a time.

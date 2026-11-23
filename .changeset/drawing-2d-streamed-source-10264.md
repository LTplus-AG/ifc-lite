---
"@ifc-lite/drawing-2d": minor
---

Draw from streamed geometry (#10264):

- `Drawing2DGenerator.generateFromSource(source, config, options, profiles?)` draws from a `DrawingMeshSource`, a replayable source of mesh batches. It reads at most two passes: `'geometry'`, and `'occlusion'` only when hidden lines or an open surface need it. It keeps no mesh between batches, so a source can lease each batch from storage and release it when the generator moves on. The drawing equals `generate` over the same meshes, and `generate` now runs on the same code. `GeneratorOptions.signal` aborts between batches.
- `Drawing2DGenerator.beginDrawing(config, options, profiles?)` returns a `DrawingSession` for callers that push leased chunks instead of being pulled: `addGeometry(batch)`, `endGeometry()` (which returns `DrawingOcclusionNeeds`: whether to feed everything again for the hidden-line raster, or only the open-surface entities), `addOcclusion(batch)`, `finish()` and `cancel()`. No batch is kept, so each lease can be released before the next one. `generate` and `generateFromSource` are drivers over this session.
- `StoreyFloorLevels` computes `storeyFloorsFromMeshes` one batch at a time.

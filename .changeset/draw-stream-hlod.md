---
"@ifc-lite/renderer": minor
---

Add an opt-in draw stream for flat colour batches, off by default: once the batch set settles, plain opaque whole batches draw through per-cell render bundles over one bind group, with optional shared geometry arenas, far-field HLOD proxies and an entity-to-batch index for highlight resync. Enable it with `Renderer.setDrawStreamConfig` (`resolveDrawStreamConfig`, `DEFAULT_DRAW_STREAM_CONFIG`, `DRAW_STREAM_CONFIG_KEYS`, `DrawStreamConfig`, `DrawStreamOverrides`). `FrameStats.stream` reports the stream's per-frame counters.

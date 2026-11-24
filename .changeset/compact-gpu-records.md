---
"@ifc-lite/wasm": minor
---

Add `MeshCollection.encodeCompact(cellSize)` and `CompactBatch`: a batch's eligible meshes as final 12-byte quantized GPU vertex records (welded on a lattice in the collection's RTC-relative frame, u16 indices, f64 boxes), so a renderer can upload them without reading a vertex. Meshes the encoder cannot take stay untouched on the f32 path. Nothing calls it yet; mesh output is unchanged.

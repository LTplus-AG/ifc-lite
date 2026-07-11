---
"@ifc-lite/renderer": minor
---

Opt-in 12-byte lattice-quantized batch vertices (issue #1682, phase 6).

`Renderer.enableQuantizedBatches()` (after a pipeline probe) switches batch builds to a 12-byte layout: uint16x4 position on a global 2^-10 m lattice + packed octahedral normal, plus the u32 entityId lane. The power-of-two lattice with lattice-aligned per-batch origins makes dequantization BIT-EXACT in f32, so cross-batch coincidence and depth-equal overlay matching survive quantization; batches exceeding the u16 range (64 m) fall back to f32 per batch. Measured: batch GPU bytes -37%, identical draw calls, 0.004% pixel delta. Off by default.

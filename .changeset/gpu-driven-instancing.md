---
"@ifc-lite/renderer": minor
---

Add opt-in GPU-driven instancing, off by default: with `Renderer.setGpuInstancing(true)` set before instanced shards stream in, instanced occurrences live in one pool of GPU tables and a compute pass culls (frustum, contribution, hide/isolate) and compacts them into per-geometry regions drawn with `drawIndexedIndirect`. Templates with byte-identical geometry share one draw; a camera move writes one uniform instead of repacking every occurrence; selection, colour overrides, picking, the selection mask and sun shadows draw from the same compacted streams.

---
"@ifc-lite/geometry": patch
---

Refuse streaming IFC sources at or above 1.5 GB before WASM allocation with a clear out of memory error; compact metadata index snapshots to avoid copying unused scan capacity.

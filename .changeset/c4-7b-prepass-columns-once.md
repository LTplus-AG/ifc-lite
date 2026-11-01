---
"@ifc-lite/wasm": patch
---

`buildPrePassOnce` now builds the type-geometry sets and the material-layer index from its own scan and installs them for `processGeometryBatch`, the way the streaming pre-pass already hands them to workers. With merge layers on, part skipping reuses the same material-layer index, and skips its aggregate scan entirely when nothing is sliceable. First batches no longer re-scan the whole file for these. Geometry is unchanged. With merge layers on, the `[ifc-lite layers]` console diagnostic now prints as it already did with merge layers off.

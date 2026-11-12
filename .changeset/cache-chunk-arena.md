---
"@ifc-lite/cache": minor
"@ifc-lite/viewer": patch
---

Decoding a cached geometry chunk copies mesh positions, normals and indices into shared, aligned ~1 MiB blocks (`ArrayArena`) instead of one ArrayBuffer per array.

**Behaviour change for callers of `decodeGeometryChunk` (and `openGeometryChunksV13(...).readChunk`):** every mesh array they return is a view into a block it shares with other meshes of the chunk. The arena is opt-in on `BufferReader`, but the chunk decode always turns it on.
- Read an array through the view: its `byteOffset` and `length`.
- Never use `.buffer` as if the mesh owned it. Transferring it to a worker detaches every other mesh in that block; `new Uint8Array(array.buffer)` covers the whole block.
- To hand one mesh's arrays to a worker, copy them first (`array.slice()`), as the viewer's zone split now does.
- In this repository, the other places that use a mesh array's `.buffer` (`cesium-glb.ts`, `scan-detector.ts`, the LandXML and zone-split workers) build or slice their own arrays and are unaffected.

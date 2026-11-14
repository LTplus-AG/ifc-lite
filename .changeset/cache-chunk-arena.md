---
"@ifc-lite/cache": minor
"@ifc-lite/viewer": patch
---

New opt-in `sharedArena` option for the geometry chunk decode: `decodeGeometryChunk(stored, info, version, { sharedArena: true })`, `openGeometryChunksV13(buffer, offset, version, { sharedArena: true })` (applies to its `readChunk`) and `BinaryCacheReader.read(buffer, { sharedArena: true })`. New type `ChunkDecodeOptions`; `ArrayArena` is exported.

- With the option, mesh positions, normals and indices are copied into shared, aligned ~1 MiB blocks (`ArrayArena`), one allocation per block instead of one ArrayBuffer per array.
  - Each array is then a view into a block other meshes of the chunk share. Read it through the view.
  - Never transfer or reinterpret its `.buffer`; copy (`array.slice()`) before handing one mesh's arrays to a worker.
- **Without the option nothing changes:** every mesh array owns its buffer, as before.
- The viewer opts in on its cache-hit decode paths. Its zone split copies the pieces it transfers.

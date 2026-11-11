---
"@ifc-lite/geometry": minor
"@ifc-lite/renderer": minor
"@ifc-lite/viewer": patch
---

Streamed meshes can now be encoded for the GPU in the geometry workers instead of on the main thread.

- `@ifc-lite/geometry/gpu-records`:
  - `encodeMeshRecords` writes one mesh's 12-byte quantized records for a model frame and a lattice origin, the same bytes the renderer's batch merge and quantizer write for it, with its world bounds and its #9068 collapse inputs.
  - `batchCollapseVerdict` combines those inputs into a batch's quantize decision.
  - `cellLatticePin` gives a streamed bucket's lattice origin from its 32 m chunk cell.
  - The renderer imports its lattice constants, octahedral normal encoding, colour salt, entity-lane packing and f32 topology check from this module, so there is one definition of each.
- `@ifc-lite/geometry/gpu-record-frame`: once the renderer has drawn a load's first fragment, `processParallel`'s new `gpuRecordFrame` option sends its frame to every worker. From then on, each worker attaches `gpuRecords` to the meshes it posts and transfers them.
- The renderer builds a streamed fragment as the concatenation of its meshes' records when every mesh carries records for exactly that fragment's frame and lattice origin, the positions, origin and colour they were encoded from are unchanged, and the fragment provably quantizes. `Scene.gpuRecordFrame()` exposes the frame. Anything else takes the main-thread merge as before. The rendered batches are unchanged.
- The viewer passes the frame for primary loads.

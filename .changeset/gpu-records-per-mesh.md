---
"@ifc-lite/geometry": minor
"@ifc-lite/renderer": patch
---

`@ifc-lite/geometry/gpu-records` encodes one mesh's quantized GPU vertex records (`encodeMeshRecords`). These are the 12-byte records the renderer's batch merge and quantizer write for that mesh, in a given model frame and against a given lattice origin. The module also returns the mesh's world bounds and its #9068 collapse inputs, and `batchCollapseVerdict` combines those into a batch's quantize decision. Records can therefore be built wherever the mesh is, such as a geometry worker, and a batch can be their concatenation. The renderer now imports its lattice constants, octahedral normal encoding, colour salt, entity-lane packing and f32 topology check from this module, so there is one definition of each. Its exports and output are unchanged.

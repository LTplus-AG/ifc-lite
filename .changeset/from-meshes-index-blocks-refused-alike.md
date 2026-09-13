---
"@ifc-lite/wasm": patch
---

`exportGlbFromMeshes` and `exportKmzFromMeshes` now refuse the same malformed index input, with the same `MALFORMED_MESH_INPUT` error (#4684). A mesh whose index count is not a multiple of 3 used to come out of `exportGlbFromMeshes` as a TRIANGLES primitive with that count, which glTF 2.0 does not allow; `exportKmzFromMeshes` quietly trimmed the partial triangle. An index naming a vertex outside its mesh was already refused by `exportGlbFromMeshes`, but `exportKmzFromMeshes` dropped that triangle and reported success with the face missing. Both writers now check each mesh's index block through one predicate in the `ifc-lite-export` crate. The viewer always passes whole, in-range triangles, so only a caller bug sees the new error.

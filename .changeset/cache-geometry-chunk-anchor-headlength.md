---
"@ifc-lite/cache": patch
---

Validate the v13 geometry section's `headLength` field against the actual parsed head size, instead of trusting it as the chunk-0 anchor.

`openGeometryChunksV13` anchors chunk 0's declared `byteOffset` at `4 + head.headLength`, since the contiguity loop that validates every other chunk against its predecessor structurally cannot anchor element 0. But `headLength` is itself an on-disk declared field, read but never used to seek during the head parse — so the anchor check (`chunks[0].byteOffset === 4 + head.headLength`) only cross-validated two independently-corruptible fields against EACH OTHER. Corrupting `headLength` and echoing the same corruption into chunk 0's declared `byteOffset` kept the two "consistent" and passed both the anchor check and the contiguity loop that follows it, even though neither matched where the head parse actually landed.

`openGeometryChunksV13` now checks `4 + head.headLength` against `reader.position` (a structural fact — where parsing meshCount/totalVertices/totalTriangles/coordinateInfo/chunkCount/directory actually ended) before trusting `headLength` for anything, and the chunk-0 anchor now compares against that same structural position rather than the declared field directly. A well-formed cache is unaffected — `headLength` always matches the true head size by construction.

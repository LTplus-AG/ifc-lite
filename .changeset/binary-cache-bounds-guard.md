---
"@ifc-lite/cache": patch
---

Harden binary parsing against truncated/corrupt input so it fails with a diagnosable error instead of a raw engine `RangeError` ("Invalid typed array length" / offset-and-length-out-of-bounds).

`BufferReader` (used by every `.ifc-lite` cache section reader — strings, entities, properties, quantities, relationships, entity index) now bounds-checks each read against the bytes actually remaining before touching the buffer. Previously `readBytes()` silently clamped via `Uint8Array.slice()` on a short buffer, and callers like `readUint32Array()` then constructed a typed array at the originally-requested element count against that shorter (copied) buffer — throwing a raw `RangeError` deep inside the engine instead of a message naming what ran short. This mirrors the guard `readInstancedShards` already hand-rolled for the same bug shape (#1238), generalized to every read.

`parseGLBToMeshData`'s `readAccessorData` (GLB/binary-glTF import) now validates an accessor's declared byte range against the actual BIN chunk length before slicing/constructing typed arrays, for both the tightly-packed and strided read paths — a malformed or truncated `.glb` with an inflated `accessor.count` previously hit the same raw `RangeError` shape instead of a clear "accessor N reads bytes [...) but the BIN chunk is only M bytes" error.

No change to well-formed input; both are purely defensive bounds checks on malformed/truncated data.

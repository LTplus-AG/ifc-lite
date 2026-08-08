---
"@ifc-lite/geometry": patch
---

Bounds-check each mesh's declared positions/normals/indices range against the shared data pool when decoding packed geometry batches, so a malformed or corrupted offset/length pair throws a diagnosable error instead of being silently accepted.

`decodePackedGeometryCacheShard` (the binary `packed-cache-shard` reader used by the desktop native cache path) and `convertPackedNativeBatch` (the Tauri-native packed-mesh-array conversion) both sliced each mesh's vertex/normal/index data out of a shared pool via `TypedArray.subarray(offset, offset + length)` with no check that `offset + length` stayed inside the pool. `subarray` saturates rather than throwing on an out-of-range end, so a mesh whose declared length ran past its pool silently received truncated data — or, when the overrun reached into a neighbouring mesh's range, silently absorbed that mesh's vertices instead. Either way the result renders as plausible-looking geometry with no error anywhere on the read path. The sibling instanced-shard decoder (`packed-instanced-decoder.ts`) already carried this exact guard; these two were missing it.

`decodePackedGeometryCacheShard` also now rejects a payload truncated below the header size or inside the data section, matching the truncation check the instanced decoder already had.

`convertPackedNativeBatch` additionally requires each offset and length to be a non-negative integer, which the binary decoder gets for free: its values come from `getUint32`, while these arrive as plain JS numbers on an IPC payload. An upper-bound comparison alone does not cover that — `NaN + length > poolLength` is false, so a NaN offset would pass and `subarray(NaN, NaN)` returns an empty view, reporting a successfully converted mesh that carries no geometry at all; a negative offset likewise passes and makes `subarray` count from the end of the pool.

No change to well-formed input; all of these are purely defensive checks on malformed/truncated/corrupted data.

---
"@ifc-lite/wasm": minor
---

`splitMeshByZones(positions, indices, zones, footprints?, footprintCounts?)` cuts one element into one closed solid per location zone, plus the remainder (issue #2508 item 2).

Everything is in the caller's frame, and positions cross as f64: the split's whole value over an AABB estimate is exactness, and an f64 to f32 round trip at the boundary would put a crack back into every shared zone plane. A zone is an oriented box by default, or a vertical prism when its `footprintCounts` entry is non-zero.

Each result carries its own enclosed volume, and the handle carries `sumErrorRel` - how far the pieces are from summing to the whole. That is the invariant the issue puts above every other for this feature, and it is exposed rather than enforced: the expected cause of a failure is zones that overlap each other, and a number the caller can show beats a silent refusal.

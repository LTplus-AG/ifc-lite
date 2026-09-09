---
"@ifc-lite/pointcloud": patch
---

Reject a zero or non-finite X/Y/Z scale factor and a non-finite offset in a LAS/LAZ header instead of silently collapsing every point to the header offset (or NaN). `decodeLasPoints`'s bbox fold now also skips a non-finite coordinate rather than letting one bad point poison the whole chunk's box. When every coordinate in a chunk is non-finite (e.g. a finite-but-huge scale that overflows on multiplication), the chunk's bbox is left at its `±Infinity` seed — an absorbing no-op in the multi-chunk union `streaming/host.ts` does across a streamed file — so the bad chunk drops out of the aggregate instead of a finite fallback value pulling it toward the origin, and a wholly non-finite file still falls back to the header's own bbox.

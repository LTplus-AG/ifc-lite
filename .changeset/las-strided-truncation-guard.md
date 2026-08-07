---
"@ifc-lite/pointcloud": patch
---

Fix `LasStreamingSource` silently emitting fabricated zero-valued points instead of erroring when a LAS file's header declares more points than the body actually backs (truncated download, corrupt/lying producer) and downsampling (`stride > 1`) is active.

The strided-read branch of `next()` always allocated its scratch buffer at the full requested size and copied into it via `subarray`/`set`; `subarray` silently saturates instead of throwing when the source slab is short, so the missing tail landed as zero bytes rather than raising an error, and those zero-derived points were reported as real decoded data. The `stride === 1` branch was already safe because it hands the (possibly short) slab straight to `decodeLasPoints`, whose own length check catches it. The strided branch now checks the read slab's length against what the requested strided window needs and throws a clear "file truncated?" error instead of fabricating points.

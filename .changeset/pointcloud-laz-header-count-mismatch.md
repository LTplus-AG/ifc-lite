---
"@ifc-lite/pointcloud": patch
---

Fix `LazStreamingSource.open()` trusting the plain-text LAS header's point count without checking it against `laz-perf`'s own decompressed record count. `next()` (and the RGB-detection probe in `open()`) loop `header.pointCount` times calling `laszip.getPoint()` — a truncated download or corrupt/malicious file whose header overstates its point count would drive that loop past what the compressed stream actually holds, an out-of-bounds read at the wasm boundary rather than a checked error. `open()` now rejects with a clear error when the header's declared count exceeds `laszip.getCount()`.

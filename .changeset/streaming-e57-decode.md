---
"@ifc-lite/pointcloud": minor
---

Stream E57 point clouds instead of decoding the whole file in memory.

`E57StreamingSource` previously read the entire `.e57` into a single
`ArrayBuffer` (plus a CRC-stripped copy of it) before decoding, so
multi-GB scans died with "Array buffer allocation failed" — a ~3.9 GB
file even slipped under the 4 GB size gate and crashed on the raw
allocation rather than being rejected.

It now reads the binary CompressedVector section incrementally: `open()`
reads only the FileHeader, the XML, and each scan's 32-byte section
header; `next()` pulls a bounded (≤ 16 MiB) logical window from the blob,
strips page CRCs on the fly, walks the DataPackets inside it, and applies
stride + per-scan pose before emitting each chunk. Peak memory is now
~one window plus one output chunk rather than the whole file. Stride
downsampling is applied natively during decode instead of after a
full-file decode.

The per-packet decode primitives are shared with the whole-file
`decodeE57Scan`, so the streaming and in-memory paths produce identical
output.

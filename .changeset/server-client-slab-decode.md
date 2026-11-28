---
"@ifc-lite/server-client": patch
---

New opt-in `sharedBuffers` parse option (`parseParquet`, `parseParquetStream`, and the flat decoders behind them): a batch's mesh `positions`, `normals` and `indices` become views into a few shared buffers (at most 64 MiB each; a single array larger than that gets its own buffer) instead of three buffers per mesh. That keeps the browser from running a full garbage collection every few dozen MiB decoded, which made a 275k-mesh model loaded beside other models several times slower. Without the option nothing changes: every mesh owns its buffers. With it, never transfer one mesh's buffer to a worker, because that detaches every other mesh of its batch; copy the array first. With the option, the decoder first rejects start or count columns that lack a row per mesh, and negative or fractional starts and counts, since it sizes the shared buffers from them; without it, malformed input is handled exactly as before.

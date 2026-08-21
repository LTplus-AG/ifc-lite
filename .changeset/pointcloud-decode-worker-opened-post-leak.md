---
"@ifc-lite/pointcloud": patch
---

Fix a decode-worker resource leak: `handleOpen` registered a newly-opened `StreamingPointSource` into the worker's `sources` map before reporting `{ kind: 'opened', sourceId }` back to the main thread. If that report failed to post, the client never learned the source's id and could therefore never send `close`/`abort` for it, leaking the source (its file reader / native buffers) for the life of the worker. The worker now reports success first and only registers the source once that succeeds, releasing it itself if reporting fails.

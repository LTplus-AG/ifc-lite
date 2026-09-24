---
"@ifc-lite/server-client": minor
---

`parseParquetStream` now asks the server to share geometry across stream batches (`stream_shapes=cross-batch`, #5407), so a streamed model downloads each distinct shape once instead of once per batch. The client keeps the shapes earlier batches sent and decodes each batch against them. It refuses a batch whose stated `vertex_base` / `index_base` does not match what it has received, or whose `batch_number` is out of sequence, instead of drawing one shape's vertices for another or silently losing a batch's meshes. Against a server that predates the option, batches carry no bases and decode on their own, as before.

---
'@ifc-lite/server-bin': minor
'@ifc-lite/server-client': minor
---

Streaming cache hits no longer pay for the upload.

`POST /api/v1/parse/parquet-stream` keys on the SHA-256 of the bytes it
receives, so the whole file had to arrive before the cache could be consulted.
On a 40 MB model that upload was the entire cost of a hit. The route now also
accepts `?sha256={hex}` with no request body: if everything the replay needs is
already cached it streams it back, and otherwise answers 404 meaning "send the
file". A hash that arrives alongside a body is ignored, so the received bytes
still decide which entry is read and written.

`parseParquetStream` in `@ifc-lite/server-client` hashes the file locally and
probes before uploading. The probe degrades to the upload whenever it is not
answered, so pointing an upgraded client at a server that predates this change
still works. This also makes a hit progressive: it used to fetch the
whole model through `/cache/geometry` and hand it over as one batch. Pass
`{ skipCacheProbe: true }` to upload straight away.

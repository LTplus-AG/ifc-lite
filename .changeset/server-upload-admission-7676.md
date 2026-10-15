---
'@ifc-lite/server-bin': minor
---

Upload admission and blocking work (#7676):

- An upload's admission reservation shrinks to 7x its decoded size (capped at `MAX_FILE_SIZE_MB`) once it has arrived, so small models no longer hold a 500 MB share of the memory budget each.
- The `parquet-stream` data-model fill runs under its stream's admission instead of waiting for a second slot, so it no longer times out on a one-slot host (where `GET /parse/data-model` then answered `404` and properties never loaded).
- gzip / `.ifcZIP` decompression and the upload's SHA-256 run on the blocking pool, not on the async workers that also serve `/health` and open streams. The data-model extraction no longer copies the whole upload.
- A compressed upload that does not decompress is `400 BAD_REQUEST`, not `500`. An upload that goes 30 s without a byte, or averages under 8 KiB/s after its first 15 s, is refused with `408 REQUEST_TIMEOUT` instead of holding its admission slot for the whole request timeout.

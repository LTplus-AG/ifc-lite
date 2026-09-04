---
'@ifc-lite/server-bin': patch
---

A cache hit on `POST /api/v1/parse/parquet-stream` replayed geometry as a single oversized `batch` event with zero `progress` events, instead of the `Start` / (`batch`, `progress`)* / `Complete` shape a live parse streams (#3895). The cached geometry blob still carries its original stream-batch boundaries as Parquet row groups; the replay now recovers them and re-emits one `batch` plus one `progress` event per original batch, byte-identical to what the live path would have sent for that batch. The streaming cache writer now pins one row group per batch (arrow-rs otherwise splits the vertex table past 1,048,576 rows, which large models cross), so the boundaries survive on exactly the models this helps. A blob with no recoverable boundary — a single row group, or a corrupt one — replays as one batch, same as before.

---
'@ifc-lite/server-bin': patch
---

A cache hit on `POST /api/v1/parse/parquet-stream` replayed geometry as a single oversized `batch` event with zero `progress` events, instead of the `Start` / (`batch`, `progress`)* / `Complete` shape a live parse streams (#3895). The cached geometry blob still carries its original stream-batch boundaries as Parquet row groups; the replay now recovers them and re-emits one `batch` plus one `progress` event per original batch, byte-identical to what the live path would have sent for that batch. A blob that doesn't decode that way (too small, corrupt) falls back to a single batch, same as before.

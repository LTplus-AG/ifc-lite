---
'@ifc-lite/collab': minor
---

`BlobStore.put` now accepts an optional `AbortSignal`, and `HttpBlobStore`
forwards it to `fetch`.

A hung upload was worse than a failed one: a rejection is counted, retried and
can trip a caller's failure ceiling, but a request that never settles produces
no failure at all, so nothing retries, no ceiling trips, and a geometry seed
never resolves while the UI reports work in progress. `LayeredBlobStore` also
forwards the signal, since its `Promise.all` cannot settle while the remote half
hangs and its `.catch` never runs when nothing rejects.

Additive and optional: existing callers are unaffected, and implementations that
cannot abort may ignore the option.

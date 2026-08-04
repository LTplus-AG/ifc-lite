---
"@ifc-lite/pointcloud": patch
---

Retry the `laz-perf` wasm load after a transient failure instead of poisoning every future `.laz` open.

`LazStreamingSource.open()` shares one lazily-instantiated wasm module across every source, memoised in a module-level `modulePromise`. That promise was assigned once and never cleared, so a rejection was cached exactly like a success: a single failed wasm fetch — a 404 from a misconfigured asset path, an offline blip, a 5xx from the CDN — left every subsequent LAZ open replaying the same rejected promise for the lifetime of the page. The user re-dropped the file and got the identical error, with no fetch ever attempted again; only a reload recovered.

The memo now lives in a small `memoizeAsync` helper that drops the cached promise when the load rejects, so the next `open()` retries. A fulfilled module is still cached forever, and concurrent opens still collapse onto a single in-flight load — dropping several `.laz` files at once instantiates the wasm once, as before. This matches the remedy already applied to `@ifc-lite/query`'s `DuckDBIntegration.init()`, which clears its cached `initPromise` on failure for the same reason.

There is deliberately no backoff: retries here are driven by a user re-opening a file, not by a polling loop, and a batch of simultaneous opens already shares one attempt.

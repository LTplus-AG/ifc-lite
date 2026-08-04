---
"@ifc-lite/geometry": patch
---

Stop the native geometry streaming loop from hanging on — or silently completing after — a failed stream, and report the failures the geometry package used to swallow.

Auditing the silent `catch {}` blocks in `packages/geometry` surfaced two real defects in the native (Tauri desktop) streaming drain loop, which exists in two near-identical copies (`streamNativeGeometry` and the inline native branch of `GeometryProcessor.processStreaming`):

- **A stream failure that never reached `onError` hung the load forever.** The loop only ends when `onError`/`onComplete` sets `completed`, so a bridge promise that simply *rejected* left it parked on a wake promise nothing resolved — no error, no `complete`, just a load that never finishes, with the reason visible only as an unhandled rejection. That is reachable today: `NativeBridge.processGeometryStreamingPath` has no `try/catch` at all, so its missing-cache-key throw and every failure of the packed-shard stream it delegates to — including the Rust-reported `failed` status and the 60-second stall guard — reject straight out, and even the siblings that do route through `onError` can reject from the `init()`/`listen()` calls preceding their `try`. A rejected stream promise is now treated as a stream error, without shadowing a richer message an `onError` already reported.
- **A stream failure that *did* reach `onError` was dropped.** The `if (streamError) throw` check sat inside the drain loop's body, but `onError` both sets `completed` and leaves the queue empty — so the wake it triggers exits the loop past that check, and the generator reported `complete` for a stream that had failed. The check is now repeated on the way out.

Both are behaviour changes on failing loads only: a failure that previously hung or was reported as a successful `complete` now throws the underlying error. Successful loads are unaffected.

Newly logged rather than swallowed, at levels matching the surrounding code: a wasm-bindgen `free()` that throws while the geometry worker recovers from a failed batch (which means the abandoned engine instance keeps its file-sized source copy in the worker's never-shrinking wasm heap — logged once per worker, because the per-entity recovery path can run thousands of times in one load); a failed wasm heap-size read at session end; a `WebAssembly.compileStreaming` rejection that forces the shared-module compile onto the buffer path, and with it a second download of the engine binary; a `stream-end` message that could not be posted to a pool worker; a worker `terminate()` that threw during pool teardown; and a failure to broadcast the `wasm-asset-unavailable` / `wasm-runtime-unrecoverable` events, which are the only way a host hears that the engine is gone.

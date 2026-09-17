---
"@ifc-lite/parser": patch
---

`WorkerParser.terminate()` now settles the in-flight `parseColumnar` promise instead of leaving it pending forever. Calling `terminate()` (or aborting a new `signal` option) terminates the worker and rejects the pending promise with an `AbortError`, so `await parser.parseColumnar(...)` no longer hangs after the documented cancellation path is used. `parseColumnar` also accepts `signal?: AbortSignal`: aborting before the call starts rejects immediately without spawning a worker, and aborting mid-parse terminates that parse's worker and rejects with `signal.reason` (a custom `abort(reason)` is passed through as-is). Overlapping `parseColumnar` calls on one `WorkerParser` are cancelled independently: a signal cancels only its own parse, while `terminate()` rejects every in-flight parse with an `AbortError`.

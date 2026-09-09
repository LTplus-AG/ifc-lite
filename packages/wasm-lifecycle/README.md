# @ifc-lite/wasm-lifecycle

Shared WASM initialization retry and panic-location forwarding for
`@ifc-lite/geometry` and `@ifc-lite/parser`. This TypeScript package does not
load or ship a WASM binary; callers supply their own initialization function
and worker-message transport.

## Initialization

`initWasmWithRetry(init, options?)` accepts an asynchronous initialization
callback and returns `Promise<void>`. It runs the callback once and retries
exactly once for a transient-looking load failure, after a default 300 ms delay.
Non-transient errors propagate immediately; a failed retry also propagates.
The callback's result is not returned.

`InitWasmRetryOptions` supports `retryDelayMs`, an injected `sleep`, an injected
`warn` logger, and a context `label`. `isTransientWasmLoadError(message)` exposes
the same message classifier for callers that need it independently.

## Forwarding panic locations

`takeWasmPanicStash(realm)` reads and consumes a realm's panic stash. It returns
a validated `WasmPanicStash` containing `location` and `at`, or `undefined`.
Consumption also removes malformed data so it cannot label a later error.

After transporting that data with a worker error, call
`restashWasmPanicLocation(realm, location, at, errorMessage)` in the receiving
realm. It accepts valid location/timestamp data only for a trap-shaped error
message and does not overwrite an existing stash. `WASM_PANIC_STASH_KEY` exposes
the shared key used by the Rust panic hook and viewer error handling.

Only the source location and timestamp belong in the stash. Panic messages can
contain model-derived text and are not part of this forwarding contract.

## License

MPL-2.0.

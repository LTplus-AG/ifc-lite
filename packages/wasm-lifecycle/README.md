# @ifc-lite/wasm-lifecycle

Shared WASM initialization retry, panic-location forwarding, single-flight
init lifetime and the worker RPC dead latch used by the ifc-lite engine and
worker clients. This TypeScript package has
no runtime dependencies and does not load or ship a WASM binary; callers supply
their own initialization function, worker and message protocol.

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

## Single-flight init

`createLifetime({ start, release?, supersededError? })` owns the init of one
long-lived resource (an engine handle, a platform bridge, a wasm module). Its
`state` is `idle`, `initializing`, `ready`, `failed` or `disposed`, each
carrying a generation.

- Concurrent `init(...args)` calls join one attempt; `start(attempt, ...args)`
  receives the arguments of the call that started it. Once `ready`, `init`
  resolves with the cached `value`.
- A failed attempt is forgotten, so the next `init()` retries.
- `dispose()` bumps the generation and releases a ready value. An attempt
  started before it is stale: its success rejects as superseded and its value
  is released rather than cached, and its failure changes nothing, so it can
  never clear or fail the attempt that replaced it. `attempt.isCurrent()` lets
  `start` skip building once it is stale. The next `init()` rebuilds.
- `reset()` releases a ready value (or forgets a failure) without touching an
  attempt in flight.

## Worker RPC

`createWorkerRpc(options)` correlates requests and answers over one worker (or
any message endpoint) and owns its failure handling, so a client cannot hang:

- **Dead latch.** The first fatal reason wins: `fail(reason)`, `dispose()`, a
  worker `error` or `messageerror`, a killing request deadline, or a failed
  `start`. It terminates the worker (or calls `close`), rejects every pending
  request, runs `onDeath` listeners once, and every later `request` rejects
  at once with the same reason. `alive` and `deadReason` report it.
- **Post-throw cleanup.** A `postMessage` that throws (for example a
  `DataCloneError`) rejects only that request and leaves no entry, deadline
  or abort listener behind; a late answer for it is ignored.
- **Deadlines.** `requestTimeoutMs` (or per-request `timeoutMs`) is clamped to
  2^31-1 ms; `0`, a negative number, `NaN` or `Infinity` means no deadline.
  `onRequestTimeout: 'kill'` (default) treats a missed deadline as fatal, for
  work that cannot be interrupted; `'reject'` fails only the late request.
- **Abort.** A request's `signal` rejects it with `abortError()`, drops its
  entry and runs `onAbort(id)` (to tell the other side to stop).
- **Start.** `start({ post, accept, timeoutMs })` runs an init handshake under
  its own deadline; `accept` maps the ready or init-error answer, and any
  failure while starting is fatal.

Pass `worker` to have the RPC post to it, listen to its `message`, `error` and
`messageerror` events and terminate it on death. Pass `post` (and optionally
`close`) instead when you own the listening, and feed inbound messages through
`receive(data)`, which returns whether it settled a request. `decode(data)`
maps an inbound message to `{ id, value }`, `{ id, error }` or `undefined`.
Ids are 1, 2, 3, … unless `nextId` supplies others (for example UUIDs).

## License

MPL-2.0.

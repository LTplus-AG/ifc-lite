<!-- SPDX-License-Identifier: MPL-2.0 -->
# IFC-Lite geometry runtime

Internal integration foundation for the shared geometry platform. The exact engine remains in Rust;
`SmlibWorker` owns one independent single-threaded SMLib subprocess for retained
BRep operations. This crate is not published and does not activate SMLib in the
viewer, server or ordinary geometry loads.

Build the pinned adapter and worker using [its instructions](../../native/smlib-adapter/README.md), then run:

```bash
IFCLITE_SMLIB_WORKER=/tmp/ifclite-smlib-adapter-native/ifclite_smlib_worker \
  cargo test -p ifc-lite-geometry-runtime
```

Without the environment variable the real SMLib geometry tests explicitly skip;
protocol fault-peer supervision tests still run.
With it, any missing/broken executable fails the tests. They run actual solids
and two independent processes concurrently; handles are worker-affine even when
wire session IDs coincide. Input operands survive destructive upstream booleans.

Protocol errors poison the client; dropping it terminates and reaps the process.
Explicit `terminate()` invalidates handles and reaps the process; `process_id()`
supports supervisor diagnostics. `SmlibWorker` calls are blocking.

`SupervisedWorker::new(executable, queue_capacity)` provides one active process
and a bounded waiting queue. `submit(WorkerCommand, timeout)` admits work without
blocking, or returns `QueueFull`. Its `PendingCommand` can be waited, cancelled
or dropped. Deadlines include queue time and handshake; they run even without a
waiter. Active cancellation and deadlines kill/reap the owned process before
completion. The next command starts a new session, invalidating older handles.
Dropping the supervisor cancels outstanding work and joins its transport threads.
A multi-process pool, automatic replay and OS memory limits remain unfinished.

`protocol::{KernelCommand, encode_request, decode_response}` is available on
native and wasm32. It encodes bounded payloads without a transport length prefix;
only native stdio adds that prefix. `WireHandle` preserves all 64 session bits.
Host/module affinity remains an execution-boundary responsibility, never inferred
from serialized numeric handles.

The [browser module-worker transport](../../native/smlib-adapter/README.md)
uses the same C++ decoder and separate module instances. Its ownership, bounded
admission, incarnation tokens, deadline and restart contract is exercised in a
real browser runner. Application asset packaging and Rust/WASM host integration
are still cutover work.

The public native client uses opaque handles, positive-dimension box/cylinder
construction in metres, tolerance-based booleans, volume/manifold queries,
bounded strict mesh transfer with revision-local source-face IDs, and explicit release.
Mesh normals are per triangle corner; positions remain f64 until a display consumer
chooses to narrow them. Host transfer limits do not bound upstream tessellation
memory; process-level resource supervision remains required before production activation. It does not accept an exact-polyhedral request. The wire contract
is [versioned here](../../native/smlib-adapter/README.md).

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

The additive staged-sweep extension keeps ABI and message envelopes at version 1.
`Capabilities` (opcode 12) returns recipe version 1 and a staged-upload bit;
13/14/15/16 begin, append, commit and abort a bounded numerical recipe. Frames
remain at most 4096 bytes; chunks hold at most 3840 recipe bytes. One session
owns at most one incomplete input, bounded to 1 MiB and 8192 curves. Malformed
chunks discard it; every commit attempt consumes it. These are transfer bounds,
not SDK heap or process limits.

`evaluate_retained_extrusion` consumes a geometry-document request for the
explicit worker incarnation, constructs an immutable capped sweep, and returns
an owned f64 tessellation plus a separate worker-affine solid handle. The caller
must release the handle. `WorkerCommand::RetainedExtrusion` runs the whole upload,
construction and tessellation under one supervisor deadline. Restart never
silently replays the document recipe or chooses another backend.

The authored processing consumer is
`ifc_lite_processing::authored_geometry::evaluator::AuthoredRetainedDocument`.
Its current admitted IFC family is source-only `IfcRectangleProfileDef` extrusion.
Circle, holed, arbitrary/trimmed and mixed curved profile admission stays refused
pending positive SDK qualification and original trim-convention preservation.
The numerical adapter's circle construction is exercised by qualification tests;
that test producer is not qualified IFC circle coverage. Publication preserves
the f64 packet, deliberately expands flat corners for display, and shares one
mesh definition across mapped occurrences. Persistent IFC faces, analytic smooth
normals and IFC appearance contracts are typed refusals. Existing canonical
appearance, mesh/default exact, USD and IFCX paths are unchanged.

This source layer has not been compiled or qualified against the SDK in its
current revision: fleet admission is blocked. Transport fault peers are not
geometry evidence. Outstanding integration includes transformed-copy boolean
operands, full source/trim metadata, surface-type/section witnesses, application
asset delivery, memory limits and supervisor undeliverable-result cleanup. Do
not activate it as a replacement production geometry path.


`browser::BrowserWorker::new()` keeps the explicit source-only lifecycle: dropping
one source realization retires its captured Worker. The separate
`BrowserWorker::new_retained_execution()` constructor selects independent object
leases. After `qualify()` executes both sweep and Boolean numerical witnesses in
that same module Worker, `evaluate_retained_boolean` accepts only sealed
`BrowserDependency::Source` / `BrowserDependency::Result` operands from that
owner. It copies the right operand into the left f64 evaluation frame before the
ordered Boolean, and seals its own independently owned result. Opaque object
identity and immutable operation/frame identity are observable for a consuming
transaction to compare; neither can construct a receipt or numerical dependency.
No source bundle or model authority is transported with these numerical values.

Dropping a lease invalidates exactly that object before queued healthy release.
A failed or uncertain command/release retires its captured Worker; abandoned Rust
futures use the captured cancellation capability. Replacement Workers are separate
owners. The source-only constructor does not enter this dependency contract.
Host mesh-byte limits and the 128-operation dependency bound are partial resource
bounds, not SDK heap limits or complete `Bounded` resource coverage.

The private driver has lightweight protocol/lifetime fixture tests, wired into
adapter CTest as `retained_driver_protocol_lifetimes`:

```bash
node --experimental-vm-modules --test rust/geometry-runtime/js/retained-driver.test.mjs
```

These tests load the actual driver with a fixture module transport. They prove
protocol ordering and lease behavior, not SDK numerics. Actual browser Rust tests
in `src/browser_bridge_tests.rs` require canonical `/smlib/` assets and a real
module Worker; they have not been run for this checkpoint. Processing now selects
these sealed browser receipts in the same `session_retained` issuance, pending,
acceptance and ledger used natively. Only numerical dispatch differs: native is
synchronous and browser awaits the private Worker. `BrowserCancellation` and
receipt `belongs_to` compare actual captured owner Arcs; liveness is checked
separately. `observe_dispatch` observes actual dispatch only, granting no transport,
response or qualification authority.

The canonical `IfcAPI.admitRetainedProduct` consumer returns an inspection witness
with explicit remaining requirements, never final product output. Its actual
browser tests and the runtime tests are wired into `geometry-platform.yml` after
canonical asset staging. Native compilation, WASM generation, actual browser
execution, broader affine target qualification and performance remain UNRUN for
this source. Halfspaces, openings, layers, final appearance/provenance and common
final publication remain incomplete. There is no default engine cutover.

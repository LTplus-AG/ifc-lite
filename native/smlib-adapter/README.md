<!-- SPDX-License-Identifier: MPL-2.0 -->
# Owned SMLib boundary

Implementation foundation for the shared geometry platform. This directory builds independently of
Cargo/pnpm and does not activate SMLib in IFC-Lite's loader or replace its exact
kernel. `include/ifclite_smlib.h` is the versioned C ABI; upstream C++ types and
allocations remain private. This is an in-process ABI, not a serialized transport.

Every session owns a slot/generation handle table. Handles include their session,
so stale handles and handles from another session are rejected. Release invalidates
a slot before it can be reused; exhausted generations retire their slots. Session
IDs are not reused during the process/module lifetime. Destroying a session frees
all remaining solids. Boolean operations copy both operands before calling the
destructive upstream API and return a separately owned result. Even identical
input handles produce separate transaction copies. Validation and reported kernel
failures leave the cached operands unchanged.

All calls **across all sessions must be serialized** by the caller. Sessions do
not isolate the process-global SM_API context. Native parallelism requires worker
processes; browser parallelism requires independent WASM module instances. The
upstream context lives for the process/module lifetime. Arbitrary invalid memory
pointers, native signals, WASM traps and allocator/kernel corruption cannot be
converted to error statuses: those require worker containment/restart. C++
exceptions are caught at each status-returning boundary; errors are copied into
caller-owned buffers. Scalar/handle outputs reset before work; buffer-copy calls
validate the range and capacity before writing caller memory.

The supported numerical domain is finite double inputs with positive dimensions;
SMLib's own geometric tolerance limits still apply. Returned volume is a numerical
integration result, and the manifold query describes the BRep topology. Neither
establishes exact arithmetic or mesh closure. No IFC interpretation,
materials, durable authoring-face provenance, BRep interchange or Rust/JS binding
is provided by this foundation yet.

## Build and verify

Prerequisites: CMake >= 3.20, Ninja, C/C++17 compilers, and an unmodified NVIDIA
`usd-brep` checkout at `c9c5979f04cea8c38213004d4f04df0dcfb40d05`.
The build checks the revision, tracked changes and untracked SMLib/SM_API files, and compiles the
minimal core/API without TBB, OpenUSD or Python. No upstream patches are applied. Run these build commands inside fleet admission;
`CARGO_TARGET_DIR` below is the absolute managed target supplied by that launcher.

```sh
cmake -S native/smlib-adapter -B "$CARGO_TARGET_DIR/ifclite-smlib-adapter-native" -G Ninja \
  -DCMAKE_BUILD_TYPE=Release -DSMLIB_SOURCE=/path/to/usd-brep
cmake --build "$CARGO_TARGET_DIR/ifclite-smlib-adapter-native" --parallel 4
ctest --test-dir "$CARGO_TARGET_DIR/ifclite-smlib-adapter-native" --output-on-failure
```

For wasm32, activate Emscripten 4.0.15 and use Node to run the same C ABI tests:

```sh
. /path/to/emsdk/emsdk_env.sh
emcmake cmake -S native/smlib-adapter -B "$CARGO_TARGET_DIR/ifclite-smlib-adapter-wasm" -G Ninja \
  -DCMAKE_BUILD_TYPE=Release -DSMLIB_SOURCE=/path/to/usd-brep
cmake --build "$CARGO_TARGET_DIR/ifclite-smlib-adapter-wasm" --parallel 4
ctest --test-dir "$CARGO_TARGET_DIR/ifclite-smlib-adapter-wasm" --output-on-failure
```

The CTest executable links a pure C translation unit to verify the public header
and ABI sizes. Behavior checks analytic box boolean volumes/manifold status,
cylinder volume, 60 repeated copy/operate/release transactions, operand preservation
on success and invalid-operation/stale-second-operand failure, slot reuse, stale
and cross-session rejection, session teardown, invalid dimensions/origins, and
bounded copied error text. These checks exercise the boundary; they do not qualify
real IFC coverage or every upstream failure/exception path.

## Native subprocess protocol

Native builds also produce `ifclite_smlib_worker`, with one serial request stream
per process. The caller owns timeouts, cancellation (terminate the worker), process
replacement and reconstruction of lost session state. This executable adds no
kernel threading. Ordinary stdout is redirected to stderr; a dedicated duplicate
of its original descriptor carries protocol frames so upstream diagnostics cannot
corrupt responses. Diagnostics belong on stderr.

All integers are little endian and doubles are IEEE binary64 bits in little
endian order. A frame starts with a `u32` byte count excluding that count itself.
Request bodies are `u32 version=1, u32 request_id, u32 opcode, payload`. Response
bodies are `u32 version=1, u32 request_id, i32 status, payload`. Success payloads
follow the table below. Failure payloads contain UTF-8 diagnostic bytes without a
NUL terminator. The worker rejects request lengths outside `[12, 4096]`, truncated
frames, unknown opcodes/versions and trailing bytes by exiting nonzero without a
response. A clean EOF at a frame boundary exits zero. Normal ABI operation errors
return a status response and leave the stream usable.

A wire handle is `u64 session, u32 slot, u32 generation` (16 bytes). Every operation
except ABI/create begins with the `u64 session` separately from any handles.

| Opcode | Operation | Request payload | Success payload |
| --- | --- | --- | --- |
| 0 | ABI version | empty | u32 ABI version |
| 1 | Create session | empty | u64 session |
| 2 | Destroy session | u64 session | empty |
| 3 | Box | u64 session, f64 x/y/z/width/depth/height | handle |
| 4 | Cylinder | u64 session, f64 x/y/z/radius/height | handle |
| 5 | Boolean | u64 session, handle left, handle right, u32 operation | handle |
| 6 | Volume | u64 session, handle, f64 relative tolerance | f64 volume |
| 7 | Manifold | u64 session, handle | u32 boolean (0/1) |
| 8 | Release | u64 session, handle | empty |
| 9 | Tessellate | u64 session, solid handle, f64 chord, f64 angle degrees | mesh handle |
| 10 | Mesh info | u64 session, mesh handle | six u32: vertices, triangles, source faces, boundary edges, spine edges, failed faces |
| 11 | Mesh read | u64 session, mesh handle, u32 stream, u32 scalar offset, u32 scalar count | scalar bytes in little endian |

Handles/session identifiers are scoped to one worker incarnation. Identical
numeric values in two workers do not identify the same geometry; the client must
bind them to worker identity and restart generation. Integration transports must
not expose a bare handle as a durable geometry reference.

Constructor admission rejects overflowing/collapsed coordinate extents and checks
manifold status plus agreement with the analytic primitive volume before
publishing a handle. Inputs at large absolute origins can therefore fail and
require local-coordinate rebasing. Volume requests outside the upstream-supported
relative accuracy interval `[1e-8, 1e-1]` are rejected rather than silently clamped.
Self-subtraction returns an owned empty BRep with zero volume, while preserving
the input solid.

Tessellation returns separately owned indexed triangles with f64 positions and
flat per-corner normals. Streams are `1=positions (f64 XYZ)`, `2=indices (u32)`,
`3=source face IDs (u32 per triangle)`, `4=normals (f64 XYZ per triangle corner)`.
Reads are bounded to 480 scalars, keeping the largest response below 4096 bytes.
Mesh buffers remain valid after source-solid release and use the common release
operation. Solid/mesh type confusion is rejected. An empty solid returns an owned
empty mesh. Source face IDs are zero-based retained-BRep `GetFaces()` indices;
they identify that evaluated revision, not IFC entities or persistent faces.

Chord height must be finite/positive in model units and angle finite in `(0,180]`.
The upstream strict tessellation API rejects partial failed faces. Its polygon
output is triangulated with the upstream planar/nonplanar algorithms, including
planar polygons with holes; no triangle fan is synthesized. Output must contain
only nondegenerate finite triangles with known source faces. Boundary/spine counts
are recomputed after triangulation; such edges reject a manifold input. No weld,
repair, coordinate rounding or f32 conversion is performed. Normals describe the
triangle surface, not analytic smooth-surface shading normals. One million source
faces/polygons/final triangles is the adapter admission budget; this does not bound
all allocations or work performed inside upstream tessellation. Worker timeouts
and process memory containment remain the integration caller's responsibility.

Real mesh tests independently check directed edge incidence, signed triangle
volume against analytic box/cylinder/boolean expectations, box boundary planes
and face grouping, cylinder vertices on analytic surfaces, normals, read bounds,
empty solids and lifetime after source release. A circular through-hole exercises
the planar triangulator's inner-loop path. Curved triangle volumes use an explicit
approximation tolerance; these tests do not certify the requested global chord error.

When Python3 is available, native CTest also runs the subprocess protocol against
real box geometry and tests malformed/truncated/oversized frames and error
recovery. Python is only a test runner; the worker has no Python runtime dependency.

## Browser worker transport

Emscripten builds also produce `ifclite_smlib_browser.mjs` and its WASM binary.
The browser module exports a small owned-buffer dispatcher. Native stdio and
browser execution share `src/protocol.cpp`: browser payloads are exactly the
version-1 bodies documented above, without the native four-byte length prefix.
There is one command decoder; JavaScript transports bytes without interpreting
IFC, topology or operation selection. The dispatcher copies the response into
an owned allocation; JavaScript copies that allocation into an independent
`ArrayBuffer` and frees both request and response allocations in `finally`.
Heap views are reacquired after kernel execution because memory can grow.

`browser/client.mjs` provides `SmlibWorkerTransport.batch(frames, incarnation)`.
Each module Worker has an independent WASM instance and serializes incoming
batches. Batches contain 1–256 payload `ArrayBuffer`s of 12–4096 bytes, transferred into the worker;
responses, including bounded mesh-stream chunks, are transferred back.
The client admits at most eight pending batches by default (`maxPending` is
configurable); invalid frames and overload are rejected before transferring bytes. Requests
become detached when posted. Neither SharedArrayBuffer nor cross-origin isolation
is required. This transport does not integrate with the viewer or activate a
production geometry path. Callers still own durable source descriptions, replay,
semantic validation of responses and mesh assembly; `contract.mjs` is test-only.

The client terminates a worker on malformed framing, a trap, a transport error or
a deadline, and rejects all pending requests. A normal ABI error remains a status
response, allowing the stream to continue. `restart()` discards the previous
incarnation and starts a fresh worker; every old session and handle is invalid.
Clients must retain a transport's opaque `incarnation` token beside their handles and
supply that value on every batch; omitted tokens are rejected.
Tokens are compared by object identity, distinguishing clients as well as restarts.
Bare numeric handles cannot identify geometry across worker replacement.
`dispose()` terminates the worker and rejects pending work; ordinary operation
lifetimes still use release/session-destroy commands. Termination releases the
entire module heap when the browser reclaims the Worker.

WASM CTest runs `smlib_browser_protocol` through the actual compiled module in
Node. It exercises two independent instances, immutable boolean operands,
analytic and independently computed triangle volume, every mesh stream,
source-solid release before mesh read, stale-handle diagnostics and malformed
requests. The browser runner additionally verifies actual module Workers,
transfer detachment, poison/restart, stale-incarnation rejection and disposal of
in-flight requests, frame-size admission and bounded pending submissions.
Fault fixtures additionally exercise host deadlines against an actually hung
Worker and initialization failure against an absent WASM asset. Both must poison
the transport within one second, reject further work until restart, and recover
through a new real-kernel Worker. A completed-request timer check waits past the
deadline and verifies the healthy transport still accepts work. Serve the build directory over HTTP and open `test.html`:

```sh
python3 -m http.server 8766 --bind 127.0.0.1 \
  --directory "$CARGO_TARGET_DIR/ifclite-smlib-adapter-wasm"
```

The machine-readable browser result is `window.probeResult`. A passing result
has `passed: true`, two matching worker results and a successful restarted-worker
result. These bounded primitive/boolean tests establish transport feasibility;
they do not qualify full IFC coverage, durable face identity, shading quality,
editing, retained BRep export or an end-to-end performance improvement.

The staged authored-sweep extension negotiates recipe format 1 with opcode 12;
it does not change ABI version 1 or any existing primitive/boolean opcode.
The C header specifies the little-endian numerical layout, sequential chunks,
declared count/length agreement, limits and transaction cleanup. Rust owns IFC
interpretation and replay recipes. The adapter creates temporary SDK curves with
RAII, calls actual `SmApiCreateLinearSweep(..., TRUE, ...)`, and publishes only
a nonempty manifold solid with matching analytic volume. Source inspection found
unchecked internal SDK cap/face statuses, so SDK success alone is insufficient.
Coefficients must lie within the explicit local numerical domain ±1e9; world
survey placement remains outside the worker in f64. Source-face indices remain
revision-local and normals flat per triangle corner.

`tests/sweep_tests.cpp` and browser `sweep-contract.mjs` add real SDK rectangle
and circle construction, a >4096-byte staged recipe, independent mesh volume,
operand immutability and cleanup/refusal witnesses. They have not been run on
this source revision. The numerical adapter now implements ordered outer/inner
loops and analytic circular arcs (derived radians converted once to SDK degrees),
with owned temporary curves and a signed analytic region-area check. Actual SDK
witness sources cover both traversal directions, negative normals, mixed arc/line
regions, rectangular/circular/multiple holes and oblique sweeps. They query tight
bounds, planar/curved surface counts, and midplane section length as independent
checks in addition to volume. These extended regions remain **unqualified** until
recorded actual execution passes; Rust source admission gates must stay in place.
Ellipse/spline/nonplanar profiles remain unsupported. Analytic surface identity is
checked only as planar versus curved here, not as durable source-face provenance.
`browser/sweep-transport.test.mjs` is a small protocol-only fault-injection suite;
its success establishes no SDK geometry behavior. It is wired through CTest.

For reproducible fleet qualification, `bash native/smlib-adapter/qualify.sh native`
(or `wasm`) acquires the public SDK at the exact pin into a dedicated temporary
cache and verifies its commit. Build directories are isolated by source commit
and checkout path under the admitted fleet `CARGO_TARGET_DIR`, so compiled
objects follow the worker storage lifecycle and CMake caches remain attributable
across runs. The public SDK/tool cache holds no default build tree. An explicitly
owned `IFCLITE_ADAPTER_BUILD` override retains its own lock and storage ownership.
Without either target the script refuses before acquisition. It bootstraps pinned public CMake/Ninja wheels
when necessary; WASM uses Emscripten 4.0.15. Run this script through `ifc-fleet run
--cwd ABSOLUTE_CHECKOUT -- ...`. On the registered Pop host, invoke the environment
wrapper with `bash` (the wrapper need not be executable):

```sh
/home/louistrue/build-workers/ifc-fleet run --host pop-os --cwd ABSOLUTE_CHECKOUT -- \
  bash /home/louistrue/build-workers/setup/projects-20261017/ifc-lite/env-exec.sh \
  bash native/smlib-adapter/qualify.sh native
```

For native Rust consumer qualification, use `native --rust-consumers` in the
same admitted command after fetching fixtures with root `pnpm fixtures`.
After every CTest passes, this option sets `IFCLITE_SMLIB_WORKER` to the executable
from that exact build, checks that it exists and is executable, then runs all
runtime and processing Cargo targets with `--no-fail-fast -- --nocapture`.
This includes model admission and lifecycle integration tests as well as common
retained transactions. SDK-gated tests cannot skip for a missing worker variable;
fixture-dependent tests still report absent fixtures, and those skips remain
missing coverage. This command does not replace workspace tests, strict Clippy,
WASM/browser tests, other consumers or performance qualification.

Native surface witnesses count geometric planes for general extrusion surfaces
using their complete positive-weight rational control hull and extrusion vector,
then independently check evaluated surface points at the unchanged `1e-8`
tolerance. The SDK's default `IsPlanar` query uses an expanded bounding box for
these surfaces; its raw result is logged separately. Curved extrusion regressions
must fail the same plane certificate. Analytic cylinder counts, volumes, bounds,
section lengths and section boundary assertions remain required. Full circles
use a canonical SDK interval and carry their authored seam phase in the rigid
frame; this avoids tiny knot spans without changing circle geometry or traversal.

## Explicit browser asset staging

After building the browser adapter above, stage its existing outputs explicitly:

```sh
node scripts/stage-retained-browser-assets.mjs \
  --build /absolute/path/to/ifclite-smlib-adapter-wasm \
  --sdk /absolute/path/to/usd-brep \
  --out /absolute/path/to/ifc-lite/apps/viewer/public/smlib
```

`--build` and `--sdk` are required absolute paths. `--out` defaults to this
checkout's `apps/viewer/public/smlib`, matching the explicit browser driver's
`/smlib/` asset URLs. The destination's parent must exist. The destination itself
must not exist: choose a new directory or explicitly remove the previous generated
bundle before restaging. Staging never replaces an existing asset tree. Serialize
staging into a given destination. SDK, build and adapter source trees cannot be
used as output destinations.

The command checks the SDK against the adapter's pinned revision and refuses
changed or untracked/ignored kernel/API inputs or license files. It validates the
CMake build's adapter/SDK paths and compares each configured browser module with
its current canonical source bytes, rejecting stale copies. It requires existing,
nonempty `ifclite_smlib_browser.mjs` and version-1 `.wasm` outputs; it does not
synthesize missing binaries. It publishes a complete directory only after all
checks and copies succeed.

The bundle contains `client.mjs`, `worker.mjs`, `module.mjs`, `sweep.mjs`,
`sweep-contract.mjs`, `contract.mjs`, `mesh-witness.mjs`, `region-recipes.mjs`,
the generated adapter module/binary, and the pinned SDK's `LICENSE` and
`THIRD_PARTY_NOTICES.md`. `asset-manifest.json` records each asset's size, SHA-256
and origin, plus the adapter source hashes and SDK pin. These identify the supplied
files; they do **not** attest that the binary was compiled from those sources.
Staging neither fetches nor builds the SDK, imports it, activates it in a default
loader, nor establishes numerical/browser qualification. Generated viewer bundles
are ignored by Git; retain any packaging manifest needed for a deployment receipt
outside the ignored tree.

This command is separate from `scripts/build-wasm.sh`, which generates the
canonical Rust WASM bindings and committed `packages/wasm/pkg/ifc-lite.d.ts`.
Staging adapter assets does not regenerate or validate those types. Run packaging
invariants with `node --test scripts/stage-retained-browser-assets.test.mjs`;
these use temporary inputs and make no SDK geometry claim.

## Additional numerical routes (unqualified)

[Round3 contract](NUMERICAL_ROUND3.md) specifies additive staged format2 for a
capped solid disk along a single clamped rational B-spline path, constructed from
Euclidean control points, positive weights, unique knots/multiplicities and a
numerical trim interval. Coefficients go directly to `CreateCanonical`; there is
no point fitting. Caller-owned original source coefficients remain separate.
Opcode17 copies a retained solid with `SmApiBrepCopy`, then invokes
`SmApiTransform` on that copy using a validated positive rigid frame.

Capability flags report implemented routes. They do not qualify any route.
The new native witnesses cover unequal-weight straight and rational circular
paths, analytic volume, tight straight bounds, translated/rotated copy mesh bounds
and preserved inputs. The actual module/browser contract exercises format2 and
opcode17 as well. These SDK witnesses have not executed; source admission gates
must stay closed pending real target receipts. General rational profile regions,
hollow disks, closed paths, fillets, periodic/unclamped splines, self-intersection
certification, scale, shear and reflection remain unsupported. No provenance,
appearance, UV, persistent face identity or process-heap bound is established.

Candidate general affine copy uses separate opcode18 and capability bit4; see
[AFFINE_CONTRACT.md](AFFINE_CONTRACT.md) for conversion certificates, numerical
bounds, ownership, unresolved classes and explicit unqualified status.

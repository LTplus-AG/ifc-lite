<!-- SPDX-License-Identifier: MPL-2.0 -->
# Owned SMLib boundary

An isolated, strictly opt-in native adapter around NVIDIA's `usd-brep` SMLib
kernel. It builds independently of Cargo/pnpm and does not activate SMLib in
IFC-Lite's loader or replace its exact kernel. Nothing in `rust/core`,
`rust/geometry`, `rust/processing` or the wasm bindings depends on it. The Rust
client lives in [`rust/geometry-runtime`](../../rust/geometry-runtime) (an
unpublished crate).

`include/ifclite_smlib.h` is the versioned C ABI; upstream C++ types and
allocations remain private. The SDK is **fetched at a pinned commit and never
vendored**; its own `LICENSE` and `THIRD_PARTY_NOTICES.md` stay with that checkout
and must accompany any binary built from it that is redistributed.

Every session owns a slot/generation handle table. Handles include their session,
so stale handles and handles from another session are rejected. Release invalidates
a slot before it can be reused; exhausted generations retire their slots. Session
IDs are not reused during the process lifetime. Destroying a session frees all
remaining solids. Boolean operations copy both operands before calling the
destructive upstream API and return a separately owned result. Even identical
input handles produce separate transaction copies. Validation and reported kernel
failures leave the cached operands unchanged.

All calls **across all sessions must be serialized** by the caller. Sessions do
not isolate the process-global SM_API context, so native parallelism requires
worker processes. The upstream context lives for the process lifetime. Arbitrary
invalid memory pointers, native signals and allocator/kernel corruption cannot be
converted to error statuses: those require worker containment/restart. C++
exceptions are caught at each status-returning boundary; errors are copied into
caller-owned buffers. Scalar/handle outputs reset before work; buffer-copy calls
validate the range and capacity before writing caller memory.

A failure inside the SDK's topology copy can leave unlinked internal allocations.
It reports `IFCLITE_SMLIB_TAINTED_DOMAIN` and the module refuses every later
status-returning call: discard the whole process.

The supported numerical domain is finite double inputs with positive dimensions;
SMLib's own geometric tolerance limits still apply. Returned volume is a numerical
integration result, and the manifold query describes the BRep topology. Neither
establishes exact arithmetic or mesh closure. No IFC interpretation, materials or
durable face provenance is provided.

## Build and verify

Prerequisites: CMake >= 3.20, Ninja, C/C++17 compilers, Python 3 (test runner
only) and an unmodified checkout of `NVIDIA-Omniverse/usd-brep` at
`c9c5979f04cea8c38213004d4f04df0dcfb40d05`. The build checks the revision,
tracked changes and untracked SMLib/SM_API files, and compiles the minimal
core/API without TBB, OpenUSD or Python. No upstream patches are applied.

```sh
git clone https://github.com/NVIDIA-Omniverse/usd-brep.git /path/to/usd-brep
git -C /path/to/usd-brep checkout c9c5979f04cea8c38213004d4f04df0dcfb40d05

cmake -S native/smlib-adapter -B build/smlib -G Ninja \
  -DCMAKE_BUILD_TYPE=Release -DSMLIB_SOURCE=/path/to/usd-brep
cmake --build build/smlib --parallel 4
ctest --test-dir build/smlib --output-on-failure
```

CTest runs three tests:

| Test | Executable | Purpose |
| --- | --- | --- |
| `smlib_owned_boundary` | `ifclite_smlib_tests` | C ABI: analytic volumes/manifold status, 60 repeated copy/operate/release transactions, operand preservation on success and failure, slot reuse, stale/cross-session rejection, session teardown, invalid dimensions/origins, bounded error text, strict tessellation with independent mesh checks, and raw shared-context metadata preservation across checked copies. A pure C translation unit verifies the public header and ABI sizes. |
| `smlib_copy_failure_boundary` | `ifclite_smlib_copy_failure_tests` | Deterministic virtual trim-copy failure on a real box: checked `MergeBrep` failure is terminal, never a partial success. Runs alone because it taints its process. |
| `smlib_worker_framing` | `ifclite_smlib_worker` | Subprocess framing against real box geometry, plus malformed/truncated/oversized frames. |

These checks exercise the boundary; they do not qualify real IFC coverage or every
upstream failure/exception path.

To exercise the Rust client against the freshly built worker:

```sh
IFCLITE_SMLIB_WORKER=$PWD/build/smlib/ifclite_smlib_worker \
  cargo test -p ifc-lite-geometry-runtime
```

`native/smlib-adapter/qualify.sh [--rust-consumers]` performs the same steps
(fetching the pinned SDK into a cache directory unless `SMLIB_SOURCE` is set) and
reports the CTest and Rust verdicts separately.

Without `IFCLITE_SMLIB_WORKER` the tests that need real SMLib geometry print a
`SKIP:` line and pass vacuously; the protocol and supervision fault-injection tests
(which use inert peer scripts, never mock geometry) still run.

## Browser module-Worker transport

An Emscripten build (`emcmake cmake ...`, Emscripten 4.0.15) produces
`ifclite_smlib_browser.{mjs,wasm}` instead of the native worker. Its only export
is `ifclite_smlib_dispatch_owned` (`src/browser.cpp`): it copies one version-1
request body (12–4096 bytes, no stdio length prefix) into the same dispatcher
and returns a separately allocated response. A nonzero return poisons that
module incarnation. The same CTest boundaries run under Node, plus
`smlib_browser_protocol`, which drives the actual browser binary through
`browser/node-tests.mjs`.

`browser/` holds the deployable JavaScript, all served together from `/smlib/`:

| Module | Role |
| --- | --- |
| `module.mjs` | Owned dispatch against one module instance; frees every allocation, refuses responses above one 4096-byte frame. |
| `worker.mjs` | Module Worker: serial batches; any fault posts `fatal` and closes the Worker. |
| `client.mjs` | `SmlibWorkerTransport`: one Worker per incarnation (a frozen object, never a number), transfer-on-submit, pending limit (`submitted: false` leaves frames attached), deadline, `retire(incarnation)` that only affects the captured owner, `restart()`. Raw handles are valid only with the incarnation that issued them. |
| `sweep.mjs` | Staged recipe upload (opcodes 12–16): capability check, ≤3840-byte chunks, abort on uncertain upload, commit never retried, foreign or stale handles retire the incarnation. |
| `sweep-contract.mjs` | The ordered-region and rational-disk witnesses the native worker runs before opening its curved gates, executed through one transport incarnation. |
| `contract.mjs` | Frame helpers and the G1 primitive contract. |

Explicit local packaging consumes an **existing** adapter build, separate Rust
`pkg-retained` build, pinned SDK checkout and Emscripten input directory. It
never fetches, builds, executes supplied JavaScript, or publishes an asset.
All paths below are absolute; choose new inventory and destination paths:

```sh
node scripts/stage-retained-browser-assets.mjs --build "$BUILD" --sdk "$SDK" \
  --engine "$ENGINE" --emscripten "$EMSCRIPTEN" --record "$INPUTS"
node scripts/stage-retained-browser-assets.mjs --build "$BUILD" --sdk "$SDK" \
  --engine "$ENGINE" --emscripten "$EMSCRIPTEN" --inputs "$INPUTS" --out "$OUT"
```

`--record` explicitly records the supplied bytes for review. Keep that inventory
outside the source/build trees and protect its integrity. Do not regenerate it
to conceal a failed comparison. It does **not** establish that a compiler used
those sources. Staging requires an exact match against the recorded assets,
source inventory, dependency edges, SDK revision and CMake cache fingerprint.
It also checks the CMake source/SDK/toolchain bindings, clean pinned SDK source
and licences, and byte equality of configured modules and Rust JS snippets.

The bundle has the adapter's CMake-configured modules (including
`dependency-contract.mjs` and `normal-contract.mjs`), generated C++ JS/WASM,
SDK licence/third-party notices, and `pkg-retained/ifc-lite.js`, its WASM and
transitive wasm-bindgen snippets. Full Emscripten, musl, libc++, libc++abi and
compiler-rt notices are copied from the supplied toolchain, checked against
pinned upstream hashes, under `notices/emscripten/`. The IFC-Lite MPL text is
under `notices/ifc-lite/`. Package metadata, credentials and toolchain binaries
are excluded. The closure scanner uses the lockfile-pinned TypeScript JavaScript
AST (no module execution). Only import/export declarations, import expressions
and supported loader calls create edges; a WASM import-object namespace such as
`"./ifc-lite_bg.js"` does not name a delivered file. Comments, URL strings,
regex literals and template expressions are parsed as JavaScript syntax.

Ordinary immutable literal-backed URLs require a uniquely bound simple `const`
whose module/block scope contains the reference and whose declaration textually
precedes it. Destructured and other binding forms count toward ambiguity but
are not evaluated. Out-of-scope constants cannot supply a path. The same rule
applies to every initializer in a literal chain. Repeated names and unsupported
scope forms fail closed; this is deliberately narrower than general JavaScript
binding analysis. Module imports require `./`, `../` or a supported absolute
path; a bare filename is not interpreted as a sibling without an import map. Canonical
client and generated wasm-bindgen/Emscripten variable-based loader forms are
accepted only against reviewed syntax profiles, including literal roots,
locator-bearing helper bodies, sinks, and the bindings/writes that feed them.
The byte-checked retained driver's helper accepts only literal call sites.
Unknown computed locators and escaped asset entry points refuse packaging.
Profiles and their representative fixtures are documented in
`scripts/fixtures/retained-loaders/README.md`; a parser/generator change requires
review and fresh parent build/browser checks, never automatic re-pinning.
The inventory covers canonical default loader assets, not files supplied later
through explicit caller URL overrides or Emscripten's optional filesystem API.
It is not a general JavaScript security analysis or a build attestation.

The deterministic manifest records exact byte counts and SHA256s. All input
checks and writes finish before Linux `renameat2(RENAME_NOREPLACE)` atomically
makes the complete directory visible at `OUT`. Existing files, empty directories
and concurrent winners are never replaced. A failure removes only this
attempt's scratch tree. Local packaging requires Linux, Python 3 and filesystem
support for this operation; unsupported hosts fail closed. Treat the output as
immutable and reverify it before any eventual authorized archive or hosting
operation. Notice revision labels identify the pinned texts, not a verified
compiler or linked-binary provenance.

The real browser consumers take the same `--build`, `--sdk`, `--engine`,
`--emscripten` and `--inputs` options. Both use this stager and its offline
integrity verifier before serving. `smlib-browser-worker-probe.mjs` adds its
separate test fixtures afterward. `retained-browser-contract.mjs` serves the
**staged** Rust engine as `/pkg/`, and the staged SDK assets as `/smlib/`.
An eventual authorized host may point the existing `loadRetainedEngine`
`moduleUrl` at `/smlib/pkg-retained/ifc-lite.js`; no new loader is introduced.

`qualified`, `buildAttestation`, `licenceClearance` and `releaseAuthorized`
remain false. These notices are conservative retention of known applicable
input texts, not a complete final-link inventory or legal clearance. Final
Rust dependencies, linked objects, source availability, build provenance,
licence review, real browser/CLI install smoke and authorized hosting remain
release gates. Exact remains default and importing the opt-in loader still
fetches nothing.

The Rust side lives in `ifc-lite-wasm` (`rust/wasm-bindings/src/retained_browser`,
wasm32, behind the off-by-default `retained-browser` feature, which also keeps
authored-source capture on wasm32), so the published package never depends on the unpublished native
`ifc-lite-geometry-runtime`. A `BrowserWorker` owns one module Worker through
the private driver `rust/wasm-bindings/js/retained-driver.mjs`, which imports
`/smlib/` only when the worker is constructed. It mirrors the native retained
contract: requests bind to the incarnation they were prepared for, curved
regions and disks need that incarnation's own `qualify()` witnesses, a dropped
realization releases only its own object before the next command, and a
dropped in-flight future retires the captured Worker. Its actual-Worker tests
run with `wasm-pack test --headless --chrome --chromedriver
scripts/wasm-test-mime-driver.mjs rust/wasm-bindings --lib --features
retained-browser -- retained_browser`
after staging `/smlib` into `rust/wasm-bindings/smlib`.

The JavaScript host contract (`IfcAPI.retainedSources`,
`RetainedBrowserExecutor`) is compiled only with the `retained-browser` feature
into the separate `packages/wasm/pkg-retained` bundle
(`BUILD_RETAINED=1 bash scripts/build-wasm.sh`), loaded on demand through
`@ifc-lite/wasm/retained`. `node scripts/retained-browser-contract.mjs --build
ABS --sdk ABS --engine ABS --emscripten ABS --inputs ABS` runs that bundle against an actual module Worker in Chromium.

Nothing in the viewer or the default WASM package imports these modules.

## Native subprocess protocol

Native builds produce `ifclite_smlib_worker`, with one serial request stream per
process. The caller owns timeouts, cancellation (terminate the worker), process
replacement and reconstruction of lost session state; the Rust crate's
`SupervisedWorker` provides a bounded queue, per-command deadlines, cancellation
and kill-and-reap. The executable adds no kernel threading. Ordinary stdout is
redirected to stderr; a dedicated duplicate of its original descriptor carries
protocol frames so upstream diagnostics cannot corrupt responses.

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
except ABI/capabilities/create begins with the `u64 session` separately from any
handles.

| Opcode | Operation | Request payload | Success payload |
| --- | --- | --- | --- |
| 0 | ABI version | empty | u32 ABI version |
| 1 | Create session | empty | u64 session |
| 2 | Destroy session | u64 session | empty |
| 3 | Box | u64 session, f64 x/y/z/width/depth/height | handle |
| 4 | Cylinder | u64 session, f64 x/y/z/radius/height | handle |
| 5 | Boolean | u64 session, handle left, handle right, u32 operation (1 union, 2 intersection, 3 difference) | handle |
| 6 | Volume | u64 session, handle, f64 relative tolerance | f64 volume |
| 7 | Manifold | u64 session, handle | u32 boolean (0/1) |
| 8 | Release | u64 session, handle | empty |
| 9 | Tessellate | u64 session, solid handle, f64 chord, f64 angle degrees | mesh handle |
| 10 | Mesh info | u64 session, mesh handle | six u32: vertices, triangles, source faces, boundary edges, spine edges, failed faces |
| 11 | Mesh read | u64 session, mesh handle, u32 stream, u32 scalar offset, u32 scalar count | scalar bytes in little endian |
| 12 | Capabilities | empty | u32 capability version (1), u32 capability bits |
| 13 | Sweep begin | u64 session, u32 format, u32 byte length, u32 loops, u32 segments | u64 upload token |
| 14 | Sweep chunk | u64 session, u64 upload, u32 offset, u32 length, recipe bytes (<=3840) | empty |
| 15 | Sweep commit | u64 session, u64 upload | handle |
| 16 | Sweep abort | u64 session, u64 upload | empty |
| 17 | Rigid copy | u64 session, handle, 16 f64 column-major matrix | handle |
| 18 | Affine copy | u64 session, handle, 16 f64 column-major matrix | output handle and affine certificate |
| 19 | Semantic empty | u64 session, handle | u32 boolean (0/1) |
| 20 | ClipPlane | u64 session, handle, point/normal 6f64, side i32, mode u32 | output handle and v1 plane certificate |

Capability bits 0 (1) and 1 (2) report staged recipe formats 1 and 2;
bit 3 (8) reports rigid copy, bit 4 (16) affine copy, bit 5 (32) semantic
empty and bit 6 (64) finite plane clipping. Capability means implementation,
never qualification. Paired splitting is not advertised. See
[the v1 plane contract](PLANE_CONTRACT.md) for ownership, domain proofs,
fixed qualification tolerances and remaining #7955 release blockers.

## Staged authored recipes

Opcodes 13-16 construct one solid from a numerical recipe that the Rust
geometry document lowered from an authored IFC source; the adapter never
interprets IFC. The byte formats are specified in `include/ifclite_smlib.h`.

- **Format 1**: a linear extrusion of one planar region, an outer loop then up
  to 127 holes, of XY lines, partial circular arcs and full circles. Outer loops
  are counter-clockwise and holes clockwise. Each full circle (kind 2) is
  validated within 1e-12 of +/-2pi and then built as an exact 360-degree SDK
  arc whose authored seam phase, normal and traversal live in its rigid frame.
  Partial arcs (kind 3) keep their exact signed interval, shifted as a whole
  into the SDK's [-360, 360] degree domain, so a trim that crosses the
  parameter seam keeps its side. The capped solid publishes only when it is
  manifold and its volume matches the region area times the projected depth.
- **Format 2**: a solid disk swept along one open, clamped rational B-spline
  with its original control points, weights, knots and parameter trim. Hollow
  disks and closed paths are refused as unsupported. The solid publishes only
  when it is manifold with positive volume.

One upload is active per session, bounded to 1 MiB, 8192 curves and 128 loops.
Chunks are sequential; an invalid chunk discards the upload. Every commit with
an output consumes the upload, including a failed one, and publishes no handle
on failure. `ctest` runs `smlib_retained_sweeps`: actual SDK solids for each
witness with independent analytic volume, bounds, mid-height section length and
strict planar/curved surface counts (oblique line extrusions are certified
planar from their control hull, not the SDK's bounding-box `IsPlanar`), plus
the upload bounds and malformed rational records.

Capability is not qualification. The Rust client opens its curved-region and
rational-disk routes only after `qualify_ordered_regions` /
`qualify_rational_disks` pass on that exact worker process.

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
the input solid. Tessellating such an empty solid yields an owned empty mesh at
the C ABI; the Rust client treats it as an inconsistent mesh and retires the worker.

Tessellation returns separately owned indexed triangles with f64 positions and
oriented source-surface per-corner normals. Streams are `1=positions (f64 XYZ)`, `2=indices (u32)`,
`3=source face IDs (u32 per triangle)`, `4=normals (f64 XYZ per triangle corner)`.
Reads are bounded to 480 scalars, keeping the largest response below 4096 bytes.
Mesh buffers remain valid after source-solid release and use the common release
operation. Solid/mesh type confusion is rejected. Source face IDs are zero-based
retained-BRep `GetFaces()` indices; they identify that evaluated revision, not IFC
entities or persistent faces.

Chord height must be finite/positive in model units and angle finite in `(0,180]`.
The upstream strict tessellation API rejects partial failed faces. Its polygon
output is triangulated with the upstream planar/nonplanar algorithms, including
planar polygons with holes; no triangle fan is synthesized. Output must contain
only nondegenerate finite triangles with known source faces. Boundary/spine counts
are recomputed after triangulation; such edges reject a manifold input. No weld,
repair, coordinate rounding or f32 conversion is performed. One million source
faces/polygons/final triangles is the adapter admission budget; this does not bound
all allocations or work performed inside upstream tessellation. The `limits` and
queue/deadline bounds of the Rust client bound transferred bytes and elapsed time;
they are **not** process RSS limits. Deployments needing a memory ceiling must apply
OS job/cgroup limits to the worker process.

## Not included

Affine rational copies, finite plane clipping and face lineage are separate,
later slices and are not part of this directory yet.

### Source corner normal contract (#7955 / J5)

The pinned SDK `SmTess::OutputFacePolygons` evaluates the surface at the UV
vertex used for tessellation, then applies its face-use reversal. `OutputToPolyBrep`
attaches this value to the corresponding outgoing edge's `SmPolyVertAuxData`.
Before triangulation the adapter snapshots these values per parent polygon and
exact `SmPolyVertex*`. Diagonal insertion may omit auxiliary data; a triangle
corner resolves only through its parent's exact vertex identity. Missing or
ambiguous associations refuse, with no nearest-triangle search or flat fallback.
Normals are never averaged across faces, creases, UV seams or polygon boundaries.
A source-face label identifies only the evaluated BRep revision, not an IFC face.

The adapter requires finite unit normals (length error at most `1e-8`) and a
strictly positive dot against triangle winding. It preserves positions, indices,
triangle order and source-face attribution. The additional source-corner snapshot
is capped at three million entries. Missing normals, zero length, unsupported
seam ambiguity or inward normals fail the tessellation without publishing buffers.
Rust and browser consumers preserve the corner stream, check its shape, unit
length and orientation, and the display boundary expands corners verbatim. They
refuse incorrect winding instead of repairing it by recomputing flat normals.
The historical `flat_corner_normals` wire name remains for compatibility.

Affine copies transform the retained rational surface before tessellation;
source normals are evaluated on that surface. The native and actual-Worker
oracles independently check inverse-transpose normals, including negative
scale, nonuniform scale and (natively) shear. Singular affine matrices retain
the existing explicit refusal. Document occurrences store placements separately;
this slice does not introduce a renderer/export transform consumer or change the
exact pipeline. RTC translation does not change a normal.

Fixed pre-run tolerances: native and Worker component error `1e-7`, unit error
`1e-8`; Rust f32 corner expansion component error `1e-7`. The cylinder oracle
uses the gradient of its source equation; cap and box classification uses all
three triangle positions, never a returned normal or source-face label. Tests
are wired into native/Emscripten CTest and the actual module-Worker probe.
These tests require parent execution before qualification. Full J5 appearance,
textures, palettes, persistent IFC identity, GPU instancing, CLI/viewer release
integration and licensing remain separate release requirements.

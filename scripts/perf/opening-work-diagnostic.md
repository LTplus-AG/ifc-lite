<!-- This Source Code Form is subject to the terms of the Mozilla Public
     License, v. 2.0. If a copy of the MPL was not distributed with this
     file, You can obtain one at https://mozilla.org/MPL/2.0/. -->

# Opening route work diagnostics

`opening-work-diagnostic.mjs` attributes actual geometry work to anonymous job
ordinals for #6516. It requires a source-matched WASM build with the opt-in
`opening-perf-trace` feature. The normal build contains neither the counters nor
their WASM export. This is a diagnostic, not a benchmark or alternate loader.

The runner observes the ordinary Node `GeometryProcessor.processStreaming`
batch calls, retaining their original prepass, RTC, tessellation, styling and
local-frame arguments. It also runs each original job separately against those
same arguments. It compares every listed raw mesh field with the original batch
and fails if their aggregate hashes differ. It returns the original collection
to the canonical loader and frees all extra collections deterministically.
This intentionally repeats work. Per-job durations exclude JavaScript mesh
hashing, but include the instrumented WASM call; they are not normal load times.
The path does not exercise browser worker scheduling or instancing.

Counters distinguish three-operand union retries, mixed planar/residual attempts
and refusals, prism deferrals, group and single subtraction calls, conformity,
and CSG failures. They count work even when a speculative route later rolls back
its ordinary telemetry. Fixed-size, saturating thread-local counters hold no
model identifiers or geometry. JavaScript reports `counterPrecisionLimited`
when any aggregate cannot be represented exactly. No clock runs inside Rust.

The #6537 ring census counts canonical simplifier calls and post-weld input
vertices, sweeps (including the final unchanged sweep), live vertex visits,
actual predecessor/successor keep-mask probes and removals. Maximum probe
distance counts circular steps including the successful probe: adjacent is one.
Distances aggregate by maximum across calls and jobs; other work counts add.
These counters do not show how much elapsed time the simplifier consumes.

For a whole-fixture native control, use the existing canonical processor through
the diagnostic example. It handles RTC itself and uses one Rayon worker so the
caller drains the same thread that performs the work:

```sh
cargo run --locked --profile server-release -p ifc-lite-processing \
  --example opening_work_probe --features opening-perf-trace -- \
  /path/public-model.ifc /tmp/instrumented-capture.json > /tmp/work.json
cargo run --locked --profile server-release -p ifc-lite-processing \
  --example opening_work_probe -- \
  /path/public-model.ifc /tmp/ordinary-capture.json > /tmp/control.json
```

The report includes input and capture SHA256, the shared ordered geometry-payload
FNV, mesh/vertex/triangle totals and per-Express-ID counts. The separate capture
contains serialized meshes, metadata and frame/transforms; it may contain model
data and is intended for local output comparisons. The default route emits no
native-only instance records; the example refuses if that invariant changes.
Capture and geometry witnesses exclude processing timings and diagnostic counters.
Keep source, compiler and binary identities alongside the reports. This
single-worker native census is neither a browser-pool benchmark nor host-specific
attribution, and output equality does not establish IFC fidelity.
The capture path must be new: the example atomically refuses existing files,
including an output path that aliases the input IFC.
Reported write or serialization failures attempt removal of the newly-created
partial file; cleanup failures report both causes.
Captures stream into the output and SHA256 without retaining a full JSON tree or
serialized byte buffer. One mesh Value is retained at a time to preserve the
original f32 formatting; a single large mesh and the canonical result can still
consume substantial memory. This representation change alone establishes no
physical-memory or performance verdict.

Interpret outcomes separately from diagnostic labels: currently `KernelError`
records an **accepted** output that failed the directed-edge closure audit. It
does not mean the subtraction rejected its output or used a box fallback. The
group rejection and AABB fallback counters distinguish those cases.

Use a separate worktree, install its dependencies, and build its geometry package
through root Turbo first. Then build the diagnostic runtime into a temporary
directory using the repository's pinned toolchain:

```sh
pnpm install --frozen-lockfile
pnpm build --filter=@ifc-lite/geometry
CARGO_UNSTABLE_BUILD_STD=std,panic_abort \
  wasm-pack build rust/wasm-bindings --target web \
  --out-dir /tmp/ifc-opening-trace --out-name ifc-lite --release \
  --features opening-perf-trace
cp /tmp/ifc-opening-trace/ifc-lite.js packages/wasm/pkg/
cp /tmp/ifc-opening-trace/ifc-lite_bg.wasm packages/wasm/pkg/
cd apps/viewer
node ../../scripts/perf/opening-work-diagnostic.mjs /path/model.ifc > report.json
```

Do not copy the diagnostic declarations into the committed default type surface.
Rebuild with `scripts/build-wasm.sh` to restore the default runtime. A subsequent
Turbo build can also replace the diagnostic artifact: verify the reported WASM
digest. Keep the exact source commit, uncommitted patch, compiler identity and
build command beside the report. A current-source trace cannot establish which
route ran in an older published version; instrument that exact source separately.

The report retains at most 50 hottest jobs and 50 jobs using union retries or
mixed staged routing, with aggregate counts for all jobs. It contains ordinals,
counts, durations and digests, but no filenames, Express IDs, coordinates or raw
library messages. Errors return a generic failure report. Share the report and
build provenance, not the private IFC or console logs.

For performance qualification, use uninstrumented source-matched builds with
the ordinary end-to-end worker-pool harness, interleaved fresh processes, and
output fingerprints. Use `stream-diagnostic.mjs` for the issue's separate normal
Node streaming boundary. An expensive counter proves that work occurred; it does
not alone prove the work was unnecessary or caused the reported slowdown.

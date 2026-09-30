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

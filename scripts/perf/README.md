<!-- This Source Code Form is subject to the terms of the Mozilla Public
     License, v. 2.0. If a copy of the MPL was not distributed with this
     file, You can obtain one at https://mozilla.org/MPL/2.0/. -->

# Performance diagnosis kit

One place to answer "where does load time go, and what is the biggest lever?"
for both the **native** Rust pipeline (CLI/server/exporter) and the **WASM**
viewer path. The two run the *same* Rust code (`process_geometry` ->
`produce_element_meshes`), so native profiling finds the algorithmic hotspots
that also dominate in the browser; the WASM-only concerns (per-worker file
re-decode, no threads, memory bandwidth) are orchestration-level and are read
off the viewer's own telemetry (below).

## TL;DR

```bash
# per-phase parse-vs-geometry attribution across the heavy fixtures on disk:
scripts/perf/probe.sh --suite --census

# one fixture, more iterations, JSON for diffing runs:
scripts/perf/probe.sh tests/models/ara3d/schependomlaan.ifc --iters 5 --json > /tmp/a.json

# symbolized flamegraph (opens Firefox profiler) to see WHICH function:
scripts/perf/flame.sh tests/models/ara3d/schependomlaan.ifc
```

Fetch a fixture first if missing: `pnpm fixtures ara3d/schependomlaan.ifc`.

## The native probe (`perf_probe`)

`rust/processing/examples/perf_probe.rs`, wrapped by `probe.sh`. It drains the
timings the pipeline already publishes (`ProcessingStats`) plus an isolated
`build_entity_index` scan, best-of-N, and prints the split:

```
  parse (pre-geometry)   <ms>   <%>     <- single-threaded; gates time-to-first-geometry
    - index-scan alone   <ms>   <%>     <- isolated build_entity_index (structural scan)
    - entity_scan        <ms>   <%>     <- scan loop + job/quick-metadata building
    - lookup/styles      <ms>   <%>     <- style/material/void resolution
    - preprocess         <ms>   <%>     <- unit scales, RTC detect, site transforms
  geometry               <ms>   <%>     <- rayon-parallel; CSG-dominated on heavy models
    - faceted-brep       <ms>   <%>     <- only with OBS=1 (features observability)
  brep point-cache       <hits>/<misses> (<rate>% memoized)
  csg census             <subtract/union/intersect/clip> | <operand-tris>
```

Flags: `--suite` (all catalogued heavy fixtures on disk), `--iters N`,
`--census` (CSG op distribution), `--json` (stdout; table stays on stderr),
`OBS=1` env (build with `observability` to fill `faceted_brep_time_ms`).

Why `--profile profiling`: release-grade opt but keeps symbols and
`panic=unwind`, so `samply` gets a symbolized flamegraph and per-element
`catch_unwind` isolation still fires. (Plain `release` strips symbols;
`server-release` keeps unwind but strips.)

### Reading it

- **`parse` large** -> the win is in the **single-threaded** scan/decode path;
  it hits every model and is the time-to-first-geometry gate in the viewer.
- **`geometry` large** -> CSG/brep bound; check `csg census` operand-tris and the
  dead-end ledger below before touching the kernel.
- `index-scan alone` vs `entity_scan`: the gap is job-list + quick-metadata
  building layered on the raw scan.

## Flamegraph (`flame.sh`)

`samply record` on the profiling binary, opens the Firefox profiler. Click into
`ifc_lite_processing::...` for parse, `ifc_lite_geometry::kernel::...` for CSG.
Install once: `cargo install samply`.

## The WASM / viewer side

The browser can't use `std::time::Instant` (traps on wasm32), so parse phases
are timed in JS. Diagnose there with:

- **PostHog `ifc_model_loaded`** (project IFClite 199147): per-load milestones
  `file_read_ms, metadata_complete_ms, first_geometry_batch_ms,
  first_visible_geometry_ms, stream_complete_ms, total_elapsed_ms` + mesh/vert/tri
  counts. Emitted in `apps/viewer/src/hooks/useIfcLoader.ts`. This is the
  **user-facing** truth (time-to-first-paint, time-to-complete).
- **Console `[stream]` timeline** (`packages/geometry/src/geometry-parallel.ts`)
  and `[useIfc] TOTAL LOAD TIME` lines: `meta @`, `styles @`, `entity-index @`,
  worker-ready, first-batch. The CI benchmark scrapes these.
- **`?perfMem=1`** -> `memoryAccounting` `[mem-summary]` (JS heap, per-worker WASM
  heap, geometry bytes, transport bytes; `apps/viewer/src/lib/perf/memoryAccounting.ts`).
- **CI viewer benchmark** (`.github/workflows/benchmark.yml`, advisory): 6 load
  milestones vs `tests/benchmark/baseline.json`, flags >50% regressions on a PR.
  Run locally: `pnpm test:benchmark:viewer:ci`; check:
  `node scripts/check-benchmark-regression.js --advisory`.
- **`?geomWorkers=N`** and `window.__ifc_lite_viewer_store__` for live poking.

WASM-specific structural cost (not in the native probe, by design):
- **Per-worker file re-decode**: each of N geometry workers re-decodes the whole
  file + rebuilds its own entity index (`packages/geometry/src/worker-count.ts`),
  the ~5x peak-memory driver. Worker count is memory-clamped, not CPU-bound
  (`SMALL_FILE_MB=24`, >512 MB caps to 3-4). More workers do **not** speed up
  CSG (memory-bandwidth bound) - see ledger.
- **No wasm threads in the live path**: `init_thread_pool` exists only in the
  `threads` bundle (off by default); cross-worker parallelism is the JS pool.

## Specialized harnesses (when the probe is too coarse)

| Tool | Question it answers |
|------|--------------------|
| `rust/processing/examples/csg_scaling_bench.rs` (`--features csg-capture`) | Does native CSG scale with cores? (captures + replays the void-cut corpus under 1/2/4/8 threads) |
| `rust/export/examples/glb_export_profile.rs` | GLB export phase split (index / mesh / assemble+serialize) + per-type triangle mass |
| `rust/csg-thread-bench/` (detached crate, `build.sh` + `web/serve.mjs`) | Threaded-WASM CSG: atomics tax + SharedArrayBuffer scaling in the browser |

## Lever ledger (read before spiking)

Encoded so a spike does not re-walk a dead end. History lives in the PRs cited.

### Shipped wins
- **Fast first-geometry** (#1185): ship index/styles/first-wave at scan-complete;
  22s -> 11.8s wall to first paint. Overlap parse + geometry.
- **Faceted-brep dedup** (#1184) + **CartesianPoint cache hoist** (#1568/#1572):
  memoize shared points across parts; big win on steel/Tekla.
- **Local-frame f32 collapse** (#1114): per-element origin removes far-from-origin
  jitter and shrinks coordinates.
- **Worker right-sizing** (#1431): `SMALL_FILE_MB` 64->24, -21% peak, 0 regression.
- **Shared entity-index on the export/native path** (#1516/#1533, #1682): one sorted
  `(id,start,end)` binary-search buffer instead of per-worker FxHashMaps, where a
  *single* consumer builds it (streaming glTF export, binary-search columns). This
  shipped and is a real win; it is NOT the viewer huge-file case below (see dead ends).
- **Vertex weld at faceted-brep source** (#1562): closes the volume-metric gap.

### Dead ends (do NOT re-spike without a new mechanism)
- **More geometry workers** -> zero CSG speedup: memory-bandwidth bound, not CPU.
- **Shared entity-index for the VIEWER huge-file path** (#1445): CLOSED, branch
  deleted, REFUTED by an end-to-end 722MB re-measure. The retained-size spike looked
  great (152 vs 354 MB/worker, projected ~600 MB lower peak) but `peakWasm` went *up*
  ~680 MB (3930 vs 3250 MB): peak is set *during* the build, `from_columns`
  double-buffers a transient `Vec<(u32,u32,u32)>` + output `Vec<u8>`, and N workers
  building concurrently spike above the old single-FxHashMap footprint. Third
  isolated-bench-misled case after #1429 and Manifold. Do NOT re-attempt without a
  transient-free in-place build — and even then the index is not the dominant cost
  (the per-worker 1x source copy is). (The single-consumer export/native shared index
  above is a *different* thing and did ship.)
- **Threaded WASM CSG** (#1429): 4.19x CSG-only isolated, but whole-pipeline only
  2.33x @ 4 threads and it REGRESSED at 8 threads (atomics tax + SAB scaling). Second
  isolated-bench-misled case. `init_thread_pool` survives in the off-by-default
  `threads` bundle only; the live path is the JS worker pool.
- **Void-cut dedup** (#1286-P5 / #1571): ~4% eligible on real models (plan-rotated
  walls ineligible AND costliest); world-frame cut can't be byte-identical. PARKED.
- **Content-dedup** (#1130): hash re-decodes the subtree, 20-30% slower net. OFF.
  (It became a NET LOSS once rect_fast made CSG cheap — a "regime rot" example: a
  measured win can flip when the surrounding cost regime changes.)
- **Manifold WASM / BSP kernel**: deleted at M9; pure-Rust exact kernel is the only
  one. C++ accelerator was a dead end.
- **Rect-fast void path**: correct where it fires but barely fires (0 on Revit/Tekla);
  not the lever.
- **CSG exact-arith**: ~15ms/cut floor is the arithmetic cost; the only lever there
  is *doing fewer/cheaper cuts* (analytic bypass), not faster exact CSG.
- **`wasm-opt` for size**: a NET LOSS on the *shipped* (brotli-compressed) bundle —
  it grows the brotli-compressed transfer size even when it shrinks the raw `.wasm`.
  Track raw AND brotli, and gate on brotli (what the user downloads).
- **`bnum` fixed-width bigint** (bnum#74): OBSOLETE post-FixedInt; the -8.9% it once
  bought is now ~0%. Another regime-rot casualty.

### Cold-start / CSG levers — mixed status (read each label)
Entries below are tagged individually: CANDIDATE (measured once, not validated end-to-end),
SHIPPED (landed with a PR), or RE-REFUTED / NOT SHIPPABLE. Do not read the section as
"all unshipped".
- **Brotli -q11 on the served bundle** (CANDIDATE — unvalidated): a single local estimate
  suggested Vercel serves ~1266 KB where brotli -q11 reaches ~947 KB (~25% smaller cold
  download). NOT confirmed against the real served response — Vercel controls its own
  on-the-fly compression and may override a precompressed asset, so this may not be
  realizable without platform support. Before claiming it: measure the actual
  `Content-Encoding`/transfer size of the deployed `.wasm` before vs after, on a clean
  deploy. Treat the 25% as preliminary context only.
- **Parser worker's unused WASM compile** (SHIPPED, PR #1851): NOT the "compile outside
  the shared memo" this was first framed as. Verified: on the streaming cold-load path
  (`waitForEntityIndex`, every file >=2 MB) the parser worker eager-compiled the ~3.9 MB
  scanner and then NEVER USED IT — the geometry pre-pass hands over the entity index and
  `entity-scanner.ts` short-circuits before the wasm scan. So the compile was pure waste
  stealing a core from the concurrent pre-pass. Fix = defer the compile (eager only on
  the no-handoff path; lazy on the timeout fallback). Win = CPU-contention relief on the
  parse<->pre-pass overlap; shows on LOW-CORE devices, so read magnitude off the CI
  viewer benchmark / PostHog, not a fast dev machine. Lesson: the "shared compile memo"
  fix was a mis-frame — verify the code path before building the fix the research names.
- **Threaded WASM CSG — in-instance rayon** (RE-REFUTED end-to-end, measured
  2026-07-23; keep in the dead-end column): a fresh browser A/B on ISSUE_129 (the most
  CSG-heavy public model, 71% CSG) settles the old CONTESTED status against threading.
  The CSG *kernel* really does parallelize in WASM (corpus replay 4152 -> 1724 ms,
  **2.41x**), but the **full pipeline REGRESSED**: plain single-thread 6450 ms vs
  threaded-8T 7383 ms = **0.87x** (byte-identical, fp=1402). The atomics tax on the
  serial parse/decode majority (2298 -> 5659 ms, ~2.5x slower) exceeds the CSG savings.
  ISSUE_129 is the *best* case, so lighter models are worse. This vindicates #1429 and
  supersedes the `docs/architecture/csg-threading-design.md` rung-2 "1.6-1.9x
  end-to-end" numbers, which have regime-rotted (see below). Do NOT wire `pkg-threaded`
  without first defeating the whole-pipeline atomics tax (not just the CSG step).
  Data: `csg-thread-bench` build.sh was itself broken (missing shared-memory link args)
  and never booted the threaded bundle until fixed in this PR.
- **Regime rot: CSG is no longer the universal bottleneck.** Native capture 2026-07-23
  (`csg_scaling_bench`): the *expensive-CSG* corpus has collapsed 10-160x vs the
  threading-doc era as the fast paths (rect_fast, analytic bypass, faceted-brep dedup)
  matured. advanced_model CSG = **4%** of load (13/316 ms; doc: 103 jobs/26 s), dental
  32%, ISSUE_068 33%, ISSUE_129 71%. The dominant cost on the majority of models is now
  the **single-threaded parse/prepass/decode/extrude path** (advanced_model 96% non-CSG),
  which gates time-to-first-geometry and hits every model — that, not CSG threading, is
  where the next real speedup lives.
- **Wide-arithmetic exact-CSG bundle** (~1.7x on a real void cut — NOT SHIPPABLE TODAY):
  built by `BUILD_WIDE=1 scripts/build-wasm.sh`, but **no stable browser runs it** — V8
  has it behind `--experimental-wasm-wide-arithmetic` (default off); `WebAssembly.validate`
  returns false on every shipping engine. Track-and-adopt only; the runtime feature-probe
  (`packages/geometry/src/wasm-features.ts`, not yet created) would auto-upgrade per engine
  as each ships. Re-check when V8 stages the flag on by default. See
  `docs/architecture/wasm-wide-arithmetic.md` (delivery status verified 2026-07-16).

### Standing constraints
- Geometry is **client-side only** (no server meshing).
- One mesh home: `produce_element_meshes` - a fix in one pipeline diverges the other.
- Parity gates: `mesh_determinism` manifests (x86_64 + arm64 + wasm32),
  `styling_parity`, `exact_predicate_determinism`. A real output change re-pins them.

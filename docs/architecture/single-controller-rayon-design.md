# Single-Controller + Rayon Design (Path B realised)

> **Status:** Design proposal, ready to execute. Builds on the validated spike at `spike/path-b-respike` (commit `8fcaff96`).
> **Scope:** Browser cold-load of arbitrary `.ifc` files. Native (Tauri) path stays as-is.
> **Target:** Cut total wall-clock for the 986 MB / 14 M-entity test file from **14.1 s → ~6-8 s** by eliminating per-worker memory duplication and using `wasm-bindgen-rayon` for in-WASM parallelism.
> **Effort:** 2-3 weeks of focused engineering work (5 medium-sized refactors).

## 1. Why this architecture exists

The current pipeline runs N (typically 3) independent Web Workers, each with its own WASM instance. This was the only browser parallelism available before the wasm-bindgen-rayon tooling matured. It works — we measure 14.1 s on the 986 MB file — but stalls there because:

- **N WASM heaps duplicate the entity-index** (~600 MB FxHashMap × N = 1.8 GB wasted).
- **Per-worker WASM init + decoder cache rebuild** costs ~1 s per worker, hidden by parallelism but visible in TTFG.
- **Cross-worker postMessage** for chunks/styles/results adds boundary overhead.
- **Adding more workers regresses**: 4+ workers contend for ~10 cores once parser, pre-pass, and main-thread are counted. We measured this hard ceiling.

The Path B re-spike (this session) confirmed the missing build flags and produced a working thread-enabled WASM (`memory[0] ... shared <- wbg.memory`). The blocker is purely architectural: wasm-bindgen-rayon expects ONE WASM instance with N internal threads, not N WASM instances with M each.

## 2. Empirical baseline (986 MB / 14 M-entity file, 10-core M-series)

| Phase | Current (3 workers) | Target (single controller + rayon) |
|---|---|---|
| File I/O → SAB | 0.6 s | 0.6 s |
| WASM init + thread pool | 0.4 s | 0.4 s |
| Pre-pass scan + meta + styles + entity-index | 3.6 s | 3.6 s (unchanged) |
| Worker first batch latency | 1.7 s | ~0.3 s (one HashMap, not three) |
| Mesh tail | 8.7 s | ~2.5 s (par_iter on 6-8 threads, no contention) |
| Parser tail | 3.0 s | 1.5 s (no contention, can also use rayon) |
| **Total wall-clock (stream)** | **14.1 s** | **~6-8 s** |
| peakWasm | 5.3 GB | ~3 GB (one heap, not three) |

The mesh tail is the dominant lever — currently 8.7 s of CPU work split across 3 workers (each doing ~73 K entities × 120 µs). With a single WASM instance running rayon `par_iter` across 6-8 threads on the same shared FxHashMap, work-stealing eliminates the per-worker rebuild AND the contention pattern that capped us at 3 workers.

## 3. Current vs proposed architecture

```mermaid
flowchart TB
    subgraph Today["Today: N workers, N WASM heaps"]
        Main1[Main thread]
        Main1 --> PP1[Pre-pass worker]
        Main1 --> GW0[Geometry W0<br/>own WASM, own FxHashMap]
        Main1 --> GW1[Geometry W1<br/>own WASM, own FxHashMap]
        Main1 --> GW2[Geometry W2<br/>own WASM, own FxHashMap]
        Main1 --> Parser[Parser worker<br/>own WASM]
        PP1 -.set-entity-index.-> GW0
        PP1 -.set-entity-index.-> GW1
        PP1 -.set-entity-index.-> GW2
        PP1 -.set-entity-index.-> Parser
    end

    subgraph Proposed["Proposed: 1 controller, rayon helpers"]
        Main2[Main thread]
        Main2 --> PP2[Pre-pass worker<br/>own WASM, single-purpose]
        Main2 --> Ctrl[Geometry controller worker<br/>ONE WASM, ONE FxHashMap<br/>initThreadPool(8)]
        PP2 -.set-entity-index.-> Ctrl
        Ctrl --> R0[rayon thread 0]
        Ctrl --> R1[rayon thread 1]
        Ctrl --> R2[rayon thread 2]
        Ctrl --> R3[rayon thread 3]
        Ctrl --> R4[rayon thread 4]
        Ctrl --> R5[rayon thread 5]
        Ctrl --> R6[rayon thread 6]
        Ctrl --> R7[rayon thread 7]
        Ctrl -.batches via SAB ring buffer.-> Main2
        Main2 --> Parser2[Parser worker<br/>own WASM, optionally also rayon]
        PP2 -.set-entity-index.-> Parser2
    end

    style Ctrl fill:#9f9,stroke:#333
    style Proposed fill:#efe
```

## 4. Validated empirical assumptions

The spike at `spike/path-b-respike` (commit `8fcaff96`) proved:
- `wasm-bindgen-rayon = "1.3"` builds with the right RUSTFLAGS (the missing piece in March was `--export=__wasm_init_tls`/`__tls_size`/`__tls_align`/`__tls_base`).
- Generated WASM imports shared memory: `memory[0] pages: initial=132 max=65536 shared <- wbg.memory`.
- `initThreadPool(2)` succeeds in 130-140 ms with no `DataCloneError`, no `__wasm_init_tls` error, no issue #36 deadlock seen.
- Atomics-enabled WASM has ~7% intrinsic memory-access cost — must be amortized by parallelism gains.

The research agent additionally confirmed:
- **Production users**: Squoosh, Google Earth, FFmpeg.wasm, `@antv/layout-wasm` all ship single-WASM-controller + wasm-bindgen-rayon to production.
- **Issue #36** (Atomics.wait deadlock) only fires when `initThreadPool` is called from the **main thread**. Calling from a Web Worker (which is what we plan) is safe.
- **Issue #32** (WebKit OOB) is unresolved as of May 2026 — Safari support requires a single-threaded fallback bundle.
- **Vite production builds work** with the upstream-tested config (Vite 6.0.5; Vite 5.4 may need `npm i -D vite@6.0.5` if the recipe fails).

## 5. Detailed component design

### 5.1 Single-controller worker (`packages/geometry/src/geometry-controller.worker.ts`)

A new dedicated Web Worker that:
1. Loads WASM once via `await init()`.
2. Calls `await initThreadPool(navigator.hardwareConcurrency - 1)` — leaves one core for main-thread render. **Critical: this is called from inside the worker, NOT main thread**, to dodge issue #36.
3. Receives the SAB-shared file source plus all metadata (RTC, styles, voids, entity-index columns).
4. Allocates a SAB ring buffer for output meshes.
5. Calls a NEW Rust entry point `processGeometryBatchParallel(jobs, output_sab_descriptor)` that internally does `jobs.par_iter().for_each(|job| { ... write to ring buffer ... })`.
6. Main thread polls the ring-buffer cursor for batches; renders as they land.

The previous N-worker `processParallel` becomes a thin wrapper that delegates to the controller. The pre-pass worker stays separate (it's already streaming and well-tuned). The parser worker stays separate (single-threaded scan + parseLite phases; doesn't benefit from rayon yet — leave for Phase 2).

### 5.2 WASM IfcAPI changes (`rust/wasm-bindings/src/api/mod.rs`)

```rust
// CURRENT (line 220-231):
pub struct IfcAPI {
    initialized: bool,
    cached_entity_index: RefCell<Option<std::sync::Arc<EntityIndex>>>,
}

// PROPOSED:
pub struct IfcAPI {
    initialized: bool,
    // OnceLock is Sync-safe and matches our actual usage (set once via
    // setEntityIndex, then only ever read via Arc::clone). No Mutex
    // overhead; cleaner than RefCell.
    cached_entity_index: std::sync::Mutex<Option<std::sync::Arc<EntityIndex>>>,
}
```

**Why `Mutex` over `RefCell` or `OnceLock` (revised after implementation):**
- `RefCell` is `!Sync` → blocks rayon's `&self` access pattern.
- `OnceLock` was the original choice but rejected: the parser worker
  reuses ONE `IfcAPI` across multiple `parse()` calls
  (`parser.worker.ts:141 cachedFullScanApi`). `OnceLock` can only be
  set once per instance lifetime; the parser pattern needs to
  REPLACE the cache between loads. `Mutex` supports this via
  `setEntityIndex` setting `*slot = Some(new_index)`. The lock is
  held only briefly at batch entry (lock → clone Arc → unlock), so
  there is no per-iteration contention on the rayon hot path.
- `clearPrePassCache` is therefore retained — the parser worker
  needs explicit between-load cleanup.
- All `.lock()` sites use `.expect("ifc-lite cached_entity_index Mutex poisoned")`
  to fail fast on Mutex poisoning rather than silently keeping
  stale data (per CodeRabbit feedback on PR #629).

### 5.3 Decoder cache → `thread_local!`

Currently `EntityDecoder` allocates a fresh FxHashMap cache per `processGeometryBatch` call (`gpu_meshes.rs:3329` `decoder.reserve_cache(num_jobs * 2)`). Under rayon, each helper thread should have its own cache that persists across rayon work-items within a batch.

```rust
use std::cell::RefCell;
thread_local! {
    static DECODER_CACHE: RefCell<EntityDecoderCache> = RefCell::new(EntityDecoderCache::new());
}

// Inside the rayon par_iter closure:
DECODER_CACHE.with(|cache_cell| {
    let mut cache = cache_cell.borrow_mut();
    let mut decoder = EntityDecoder::with_cache(content, &entity_index_arc, &mut cache);
    // ... per-entity work ...
});
```

This eliminates the ~few ms per-call FxHashMap allocation, retains decoder cache hits across consecutive rayon tasks on the same thread, and has zero contention because each thread has its own.

### 5.4 SAB ring buffer for streaming output (`packages/geometry/src/mesh-ring-buffer.ts`)

The canonical pattern for streaming results out of rayon ([reference](https://github.com/PaulKinlan/sab-ring-buffer)):

```
SAB layout:
[ header: 16 bytes ]   write_cursor (Int32), read_cursor (Int32), capacity, flags
[ slot 0  ]            mesh batch descriptor: { offset, length, expressId }
[ slot 1  ]
...
[ slot N  ]
[ data pool ]          contiguous mesh vertex/index/color bytes
```

Rust writes batches via `Atomics.compare_exchange` on the write cursor. Main thread polls (via `requestAnimationFrame`) or `Atomics.waitAsync` on cursor changes.

This is the only pattern that lets rayon helpers stream individual batches without serializing through the WASM-JS boundary one-at-a-time. It also enables our existing `first batch in 200-500 ms` target — main thread renders the first batch while the bulk continues in parallel.

**Falls back gracefully**: if SAB unavailable (no COI), use a simple `Vec<MeshBatch>` returned at end of `processGeometryBatchParallel`. Slower TTFG but works.

### 5.5 Stack size and production posture

```toml
# .cargo/config.toml — required additions for rayon recursion
[target.wasm32-unknown-unknown]
rustflags = [
  # ... existing flags from spike ...
  "-C", "link-arg=-z", "-C", "link-arg=stack-size=4194304",  # 4 MB
]
```

CSG/brep boolean operations recurse deeply on complex geometry. The default 1 MB wasm stack overflows on real-world IFC files. 4 MB is the upstream wasm-bindgen-rayon recommendation; tested against complex models in the wasm-bindgen examples.

`ThreadPoolBuilder::stack_size()` is **ignored on wasm32** — only the linker arg works.

### 5.6 Production posture: Chromium/Firefox first, Safari opt-out

Use `wasm-feature-detect` to choose at runtime:

```ts
import { threads } from 'wasm-feature-detect';

const useThreaded = await threads();  // checks +atomics + crossOriginIsolated + Safari workarounds
const wasmModule = useThreaded
  ? await import('@ifc-lite/wasm-threaded')   // new bundle: shared memory, rayon-enabled
  : await import('@ifc-lite/wasm');            // existing bundle: no shared memory
```

**Trade-offs:**
- **Bundle size**: doubles the WASM bundle (1.0 MB single-thread + 1.1 MB threaded = 2.1 MB total). Acceptable for an IFC viewer.
- **Build time**: doubles WASM build (~30 s instead of 15 s). Acceptable.
- **Maintenance**: two binaries to test. Mitigated by Playwright cross-bundle smoke tests.
- **Safari users**: silently fall back to single-thread path. Slower but correct. Document this in user-facing docs.

`vercel.json` keeps `Cross-Origin-Embedder-Policy: credentialless` (works on Chrome 96+, Firefox 110+; Safari uses fallback bundle anyway).

## 6. Migration plan (phased, shippable at every step)

Each phase ends with a green main, regressions caught early, and deployable at any point.

### Phase 1 — WASM-side prep (~3-5 days)

**Goal:** Rust/WASM ready for parallel access from a single instance. JS unchanged.

**Changes:**
- `rust/wasm-bindings/src/api/mod.rs`: `RefCell<Option<Arc<EntityIndex>>>` → `OnceLock<Arc<EntityIndex>>`.
- `rust/geometry/src/decoder.rs` (or wherever the cache lives): introduce `thread_local!` decoder cache.
- `.cargo/config.toml`: add stack-size linker arg (4 MB).
- New WASM build target: `pnpm build:wasm:threaded` produces `packages/wasm-threaded/pkg/` with full thread-enabled flags. Keep existing `pnpm build:wasm` for the default bundle.
- New Rust function `processGeometryBatchParallel(jobs, ...)` that internally does `par_iter` — initially called from a TEST harness only, not from the main pipeline. **Validates parallelism works in isolation.**

**Validation:**
- `wasm-objdump -j Import` confirms `memory[0] ... shared`.
- Test harness on a 100 MB fixture: parallel call returns same meshes as serial (correctness).
- Microbenchmark: parallel call is ≥2× faster than serial on the harness.

### Phase 2 — Single-controller worker scaffolding (~3-4 days)

**Goal:** New `geometry-controller.worker.ts` exists, can do everything the N-worker pipeline does (correctness only — perf comes in Phase 3).

**Changes:**
- New file `packages/geometry/src/geometry-controller.worker.ts`.
- It loads the threaded WASM bundle (with feature-detect fallback to single-thread bundle).
- Calls `initThreadPool(navigator.hardwareConcurrency - 1)` ONCE at startup.
- Accepts the SAME message protocol as the N-worker pool (`init`, `stream-start`, `stream-chunk`, `stream-end`, `set-styles`, `set-entity-index`).
- For each `stream-chunk`: calls `processGeometryBatchParallel` instead of `processGeometryBatch`.
- Emits same `batch`/`memory`/`complete` events.

**Wired behind a feature flag** in `useIfcLoader.ts`:
```ts
const USE_SINGLE_CONTROLLER = window.localStorage.getItem('ifc-lite:single-controller') === '1';
```

**Validation:**
- With flag off: identical behavior to today.
- With flag on: same total time on 986 MB file (correctness baseline).
- Memory: peak WASM should drop from 5.3 GB to ~2-3 GB (one heap instead of three).

### Phase 3 — SAB ring buffer for streaming output (~3-5 days)

**Goal:** Mesh batches stream out without per-batch postMessage round-trips.

**Changes:**
- New `packages/geometry/src/mesh-ring-buffer.ts`: SAB allocator + Atomics-based cursor protocol.
- Rust `processGeometryBatchParallel` writes to the ring buffer instead of returning a `MeshCollection`.
- Main thread (via the controller) polls cursor in `requestAnimationFrame`, drains batches.
- First-paint optimization: `rayon::scope` splits first batch into a `s.spawn()` priority task and the rest into `par_iter` — first task lands in <500 ms.

**Validation:**
- Time-to-first-batch: 5.3 s → ≤1 s on 986 MB file.
- No batch loss (mesh count matches end-to-end).
- Cursor protocol fuzz test: 1000 random batch-emit sequences validate no race conditions.

### Phase 4 — Delete N-worker pipeline + clean up (~2-3 days)

**Goal:** Remove the old code path once Phase 3 is proven stable.

**Changes:**
- Delete `processParallel`'s worker pool spawning logic.
- Delete `geometry.worker.ts` (or reduce it to just the pre-pass entry point).
- Remove the feature flag.
- Update `worker-count.ts`: rename `pickWorkerCount` to `pickThreadCount`, return rayon thread count instead of worker count.
- Update `memoryAccounting.ts`: track single heap, not aggregated.

**Validation:**
- Regression suite (`pnpm test:regression` on 4 local fixtures + viewer benchmark).
- 986 MB target: 14.1 s → 6-8 s confirmed.
- peakWasm: 5.3 GB → ~3 GB confirmed.

### Phase 5 (optional, follow-up) — Parser worker also moves to rayon

If parser tail is now the new bottleneck (it might land at 3-4 s, which is past the 6-8 s stream complete), repeat the same pattern for the parser:
- Move parser into a controller-style worker with its own rayon pool (or share the geometry controller's pool — needs investigation).
- `parseLite` phases like `categorize` and `compact entity index` parallelize naturally.

Estimated additional win: 1-2 s on data-model-complete time.

## 7. Testing & validation plan

### 7.1 Correctness

**The 4 local fixtures cover the failure modes:**
- `test-2026.ifc` (0.5 MB): smoke test, verifies the threaded bundle initializes correctly on small files.
- `THX (sanitär).ifc` (208 MB): backward-heavy refs, verifies decoder cache thread-locality doesn't drop entries.
- `TUN32-BT2-ARK.ifc` (183 MB): forward-heavy refs (85% forward), verifies rayon ordering doesn't break reference resolution.
- `merged_export(13).ifc` (986 MB): the target. End-to-end perf + correctness.

For each: verify mesh count, vertex count, spatial hierarchy, property lookups all match the current N-worker baseline byte-for-byte.

### 7.2 Cross-bundle parity

The threaded and single-thread bundles must produce identical output. CI matrix:
- Chromium with threaded bundle (the main path)
- Chromium with single-thread bundle (fallback)
- Firefox with threaded bundle
- Safari with single-thread bundle (Safari can't do threaded per issue #32)

### 7.3 Performance gates

The benchmarking suite at `tests/benchmark/viewer-benchmark.spec.ts` already tracks total wall-clock. Add new gates:
- `peakWasmHeapBytes ≤ 3.5 GB` on 986 MB file (currently 5.3 GB).
- `streamCompleteMs ≤ 9000` on 986 MB file (currently 14215).
- `firstVisibleMs ≤ 2000` on 986 MB file (currently 4823).

### 7.4 Production-build smoke test

The original blocker was production build. Smoke test in CI:
- `pnpm build:wasm:threaded`
- `pnpm build` (Vite production build)
- `pnpm preview` + Playwright load test
- Verify thread pool initializes (check console for `rayon pool ready (N threads)`).

If Vite 5.4 fails this, pin to Vite 6.0.5 (the upstream-tested version). Track as a separate task.

## 8. Risks + mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Vite 5.4 production build fails the upstream recipe | Medium | High (blocks the rollout) | Pin Vite to 6.0.5 OR add `vite-plugin-static-copy` for snippets. Fallback: ship single-thread bundle to all browsers temporarily |
| Issue #36 (Atomics.wait deadlock) fires intermittently | Low | Medium | Init from controller worker (not main); retry-with-25ms-backoff wrapper around `initThreadPool` |
| WebKit/Safari issue #32 (OOB memory) | High for Safari users | Medium | wasm-feature-detect fallback bundle; document as Chromium/Firefox first |
| `OnceLock` migration breaks something | Low | Medium | The current `RefCell` only holds set-once data; migration is mechanical. Comprehensive test on all 4 fixtures. |
| Decoder cache thread-locality breaks reference resolution | Medium | High (correctness) | Test on TUN32 (forward-heavy refs, the worst case). Fuzz test with synthetic IFC files. |
| Stack overflow on extreme CSG geometry | Low | Medium | 4 MB stack via linker arg. Test on advanced_model.ifc (35 MB, complex CSG). |
| SAB ring buffer overflow on burst-mesh files | Medium | Medium | Cursor protocol must support backpressure. Drain in rAF; if cursor stalls, controller pauses rayon dispatch. |
| Atomics-tax wipes out parallelism gains for I/O-bound files | Low | Low | We measured +1 s overhead. Mesh tail with rayon should save 5-6 s. Net positive even for smaller files. |
| Rayon work-items too small (per-face triangulation < 10 µs) | Medium | Low (loses some parallel gain) | Use `par_chunks(N)` with N=100-500 to batch fine work. Per the research agent: per-task overhead in rayon dominates below ~10 µs. |
| Parser worker still single-threaded becomes new bottleneck | High (intentional in Phase 4) | Low | Phase 5 addresses if needed |

## 9. Effort breakdown

| Phase | Work | Estimate | Confidence |
|---|---|---|---|
| Phase 1 — WASM prep | RefCell→OnceLock; thread_local cache; stack-size; threaded build target; test harness | **3-5 days** | High (mostly mechanical) |
| Phase 2 — Controller worker scaffolding | New worker file; same protocol; feature flag | **3-4 days** | Medium-high (well-understood pattern) |
| Phase 3 — SAB ring buffer | New ring buffer module; Rust write side; main poll side; first-batch fast-path | **3-5 days** | Medium (novel but well-documented) |
| Phase 4 — Delete N-worker, clean up | Remove old code path; rename functions; update memory tracking | **2-3 days** | High |
| Phase 5 (optional) — Parser also rayon | Repeat pattern for parser | **3-5 days** | Low (depends on Phase 4 results) |
| Testing buffer | Cross-browser, fixture validation, perf gate tuning | **2-3 days** | High |
| **Total** | **~16-25 days** ≈ **3 weeks** for Phases 1-4 | | |

Phase 5 (parser also rayon) is bonus work; gate on whether parser tail is the new bottleneck after Phase 4.

## 10. Out of scope (explicit non-goals)

- **GPU compute for triangulation.** Investigated and rejected (~30 % of per-entity time; GPU upload overhead eats the win for small meshes; WebGPU browser support fragmented).
- **Pre-indexed `.ifcl` binary format.** Separately interesting (could hit ~3 s cold-load), but it's a product change (input format), not a loader change.
- **Multi-instance threaded WASM.** The whole point of this design is to consolidate to ONE instance. Trying to do both is the trap we just escaped.
- **Native (Tauri) path changes.** Native already uses real Rayon natively. Out of scope.
- **Replacing the pre-pass worker.** It's well-tuned and streaming. Leave it.
- **Comlink dependency.** The research agent recommended Comlink for the message protocol but our existing protocol is well-defined and reuse-friendly. Stick with it.

## 11. Decision log

- **OnceLock over RefCell over Mutex** — set-once usage doesn't need Mutex's runtime overhead.
- **Decoder cache as `thread_local!`, not per-call allocation** — preserves cache hits across rayon tasks within a batch.
- **SAB ring buffer over postMessage drain** — research agent flagged that helpers blocked in `Atomics.wait` can't service postMessage; SAB cursor sidesteps this.
- **`navigator.hardwareConcurrency - 1` thread count** — leave one core for main-thread render. Don't oversubscribe.
- **Init `initThreadPool` from controller worker, not main** — sidesteps issue #36.
- **wasm-feature-detect fallback bundle** — Safari can't do threading; ship a single-thread bundle for them.
- **Keep COEP `credentialless`** — works on the browsers that support threading anyway; Safari hits the fallback bundle either way.
- **Pre-pass worker stays separate** — it's well-tuned, streaming, and a separate concern. The 3.6 s pre-pass is not the bottleneck after Phase 3.
- **Parser worker stays separate (Phase 1-4)** — parser tail is currently dominated by JS phases, not WASM. Move to rayon in Phase 5 if it becomes the bottleneck.
- **Feature flag for the N-worker → controller transition** — lets us A/B compare in CI and roll back instantly if a regression slips through.

## 12. Outcome (added after empirical validation)

Phases 1.1, 1.3, 1.4, 1.5, 2 were implemented and tested end-to-end on
the 986 MB / 14 M-entity test file. The findings invalidate this
design's wall-clock predictions — preserving the doc as a record of
the architectural exploration and to prevent the same path being
re-walked.

### What worked exactly as predicted

- **Build pipeline**: `wasm-bindgen-rayon = "1.3"` builds cleanly with
  the full RUSTFLAGS bag (the missing `__wasm_init_tls` exports were
  the March 2026 blocker — fixed in spike `8fcaff96`).
- **Production Vite build**: works. `workerHelpers.js` ships to
  `dist/assets/`. Zero "Attempting to create a Worker from an empty
  source" warnings in the production preview (those were dev-mode
  artifacts).
- **Helper threads spawn and run**: confirmed via diagnostic
  instrumentation. 9 unique rayon thread indices observed, 9-thread
  pool. No `DataCloneError`, no issue #36 deadlocks.
- **Pure-CPU microbenchmark scaling**: 9-thread parallelism delivers
  **5.76× speedup** on a stack-only integer-math workload (219 ms
  serial → 38 ms parallel). 64 % efficiency. wasm-bindgen-rayon's
  runtime is healthy.
- **Memory consolidation**: single-controller + single WASM instance
  drops peakWasm from 5.3 GB → 2.6 GB on the 986 MB file (50 %
  reduction). Confirmed.

### What did NOT work — workload mismatch

- **Wall-clock REGRESSED 4× with the controller path enabled**: 14.1 s
  → 53 s on the 986 MB file. Same correctness (final mesh count
  identical), but vastly slower stream tail.
- **Cause**: `processGeometryBatchParallel`'s per-entity work is
  ~80 µs decode (SAB byte parsing + reference following) plus ~40 µs
  mesh generation. Threading converts the decode reads to
  atomic-imported-memory loads, which are slower per-op AND contend
  across helper threads. Combined with per-rayon-task EntityDecoder
  cache rebuilds (lost decoder cache locality across tasks) and
  per-task allocator atomics, the overhead exceeds any parallelism
  gain on the 40 µs-per-entity mesh portion.
- **Root finding**: the IFC processGeometryBatch hot path is
  **memory-traversal-dominated**, not compute-dominated.
  wasm-bindgen-rayon shines on compute-bound workloads (image
  codecs — Squoosh, FFmpeg.wasm); IFC parsing/decoding has the
  opposite shape.

### Option 1 (de-normalize before parallel) post-mortem

Considered as a salvage: serial pre-decode pass that builds a dense
`Arc<FxHashMap<u32, Arc<DecodedEntity>>>` so the parallel section
operates on warm in-WASM-heap data, not SAB-imported memory.

Math after the microbench result:
- Pre-warm pass (serial, decode-bound): 188 K entities × 80 µs = ~15 s
- Parallel mesh pass (5.76× scaling on the 40 µs portion): 188 K ×
  40 µs / 5.76 ≈ 1.3 s
- **Total: ~16 s — WORSE than the 14 s N-worker baseline.**

Decoder cost dominates and decoding is inherently serial-friendly
(can't escape SAB byte access). Option 1 was abandoned before
implementation based on the math.

### What the threaded build IS still good for (kept as latent
infrastructure)

- The threaded WASM build target (`packages/wasm-threaded/pkg/`) and
  `packages/wasm-threaded` workspace package stay in the repo. They
  are unused by default (single-thread bundle is the only one the
  viewer imports today) but available behind the
  `localStorage['ifc-lite:single-controller']` flag for future
  experiments where the workload may be CPU-bound (e.g. WebGPU
  compute-shader fallback, batch geometry simplification, BIM ML).
- The microbenchmark function (`benchmarkPureCpuParallelism`) stays
  as a re-runnable verification harness for future contributors who
  want to confirm the runtime is still healthy before investing in a
  rayon-based optimization.
- The full RUSTFLAGS recipe + Cargo configuration is in
  `.cargo/config.toml` + `scripts/build-wasm.sh` and serves as
  reference for any future thread-enabled WASM work.

### Realistic next-step paths

Given the workload mismatch, the honest paths to meaningful
improvement on cold-load wall-clock are NOT parallelism-based. They
are:

1. **Reduce work per entity** — global CartesianPoint cache that
   dedups the most-frequently-decoded sub-entity across the entire
   load. Estimated 1-2 s win on cold-load. Localized Rust change in
   the decoder.
2. **Profile-guided Rust hot-path optimization** — `cargo flamegraph`
   on a native build, find the top 3-5 hot functions, optimize each.
   Bounded but additive 10-20 % wins.
3. **Variance reduction** — pre-allocated SAB-backed mesh buffer pool
   to reduce JS-side GC pressure during peak mesh assembly. Tightens
   the observed 14-20 s spread to a predictable 14-15 s.
4. **Workload change** — if repeat loads of the same file are common,
   a `.ifcl` binary cache format hits ~2-3 s on subsequent loads
   while leaving cold-load of NEW files unchanged. Real 5× for
   warm-cold workflows.
5. **View-aware loading** — UX-side change. Render bounding boxes
   immediately, mesh only entities in the initial frustum, lazy-mesh
   on demand. Total load time unchanged but TTFG drops to <2 s.

These are scoped as separate tasks and deferred to a focused
follow-up session. The threaded-WASM exploration is complete; this
section documents the wall it hit so future contributors don't
re-walk it.

## 13. References

- Spike commit: `8fcaff96` on branch `spike/path-b-respike` — known-working build flags + Cargo.toml.
- Predecessor design: `streaming-load-design.md` (Path A + C; superseded by this for the geometry side).
- Upstream wasm-bindgen-rayon active fork: https://github.com/RReverser/wasm-bindgen-rayon
- Production reference: https://github.com/GoogleChromeLabs/squoosh (single controller + Comlink + threaded WASM).
- SAB ring buffer pattern: https://github.com/PaulKinlan/sab-ring-buffer
- `wasm-feature-detect`: https://www.npmjs.com/package/wasm-feature-detect
- Issue #36 (Atomics.wait deadlock): https://github.com/RReverser/wasm-bindgen-rayon/issues/36
- Issue #32 (WebKit OOB): https://github.com/RReverser/wasm-bindgen-rayon/issues/32
- Stack size on wasm32: https://users.rust-lang.org/t/increasing-rust-wasm32-stack-size/73605

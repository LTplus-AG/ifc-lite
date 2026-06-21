<!--
This Source Code Form is subject to the terms of the Mozilla Public
License, v. 2.0. If a copy of the MPL was not distributed with this
file, You can obtain one at https://mozilla.org/MPL/2.0/.
-->

# Threaded-WASM CSG — design & evidence

Status: **validated by measurement, not yet wired into production.** This is the
successor to the deleted `single-controller-rayon-design.md` (§12 of which
recorded a 4× *regression* and shelved WASM threading). That verdict is **stale**:
it was measured in May 2026 on the BSP/decode-dominated pipeline, a month before
the pure-Rust exact CSG kernel (#1024) inverted the workload. Re-measured on the
current kernel, threading is a **net win**.

## TL;DR

- The pure-Rust exact CSG kernel is **compute-bound** (predicate-dominated, the
  rational tier is cold) with **tiny, cache-resident per-element working sets**
  (0.4–2.2 MB even on a 177 MB model). That is exactly the shape WASM threads win
  on — the opposite of the decode path §12 measured.
- **Atomics tax ≈ 0%** on this kernel (the spike's ~7% tax was on memory-heavy
  decode; the kernel barely touches memory).
- A threaded WASM build (shared memory + `wasm-bindgen-rayon`) scales the CSG step
  **~2.9–4.2×** at 8 threads, and a **naive whole-pipeline** threaded build still
  nets **~1.6–1.9×** end-to-end — no regression — because CSG now dominates.
- The right architecture threads **only the CSG-heavy element loop**; decode and
  parse stay as they are. Two bundles ship (threaded + plain) because Safari does
  not support `credentialless` cross-origin isolation.

## Measured evidence (10-core Apple Silicon, 4P+6E)

### Rung 1 — native, CSG isolated (decode excluded)
Across 6 real models: **95–99% efficiency at 2 cores, 83–96% at 4**, plateauing
~4.3–5.5× at 8–10 (P/E asymmetry, not bandwidth — working sets are cache-resident).
Harness: `rust/processing/examples/csg_scaling_bench.rs` (`--features csg-capture`).

### Rung 2 — threaded WASM, CSG corpus replay (real captured cuts)
Decision number = current single-thread WASM ÷ threaded-parallel WASM:

| model | jobs | plain serial | 4 threads | 8 threads |
|---|---|---|---|---|
| ISSUE_068 | 970 | 13,683 ms | 4,805 (2.85×) | 3,266 (**4.19×**) |
| dental_clinic | 245 | 7,728 ms | 2,637 (2.93×) | 1,850 (**4.18×**) |
| advanced_model | 103 (heavy-tail) | 26,273 ms | 11,017 (2.39×) | 8,994 (**2.92×**) |

Atomics tax: plain-serial 13,683 vs threaded-serial 13,638 ms → **~0%**. Output
fingerprint byte-identical across every thread count. WASM retains ~76–92% of
native's multicore scaling (dlmalloc single-lock contention is real but modest;
worst on many-small-job models). Harness: `rust/csg-thread-bench/` + `web/`.

### End-to-end — threaded WASM, full pipeline (parse+prepass+decode+CSG)
Naive whole-batch threading (`process_geometry`'s existing `par_iter`):

| model | plain serial | threaded 8T | speedup |
|---|---|---|---|
| ISSUE_068 | 17,108 ms | 9,020 ms | **1.90×** |
| advanced_model | 29,008 ms | 18,100 ms | **1.60×** |

The gap between the pure-CSG ceiling (4.19×) and end-to-end (1.90×) is the
**serial parse + serial prepass + memory-bound decode** that does not thread.
That gap is the optimization target, not a blocker.

## Architecture

Two viable shapes:

1. **Naive (proven +1.6–1.9×):** build the geometry path as a threaded bundle and
   call `initThreadPool(navigator.hardwareConcurrency)` once. The existing
   `par_iter` over elements (`processor.rs:1554`, `gpu_meshes.rs:882`) becomes
   parallel with **zero algorithm changes**. Decode threads too and pays a small
   penalty, but CSG dominance keeps the net positive on geometry-heavy models.

2. **Surgical (recovers toward the 4× ceiling):** one shared-memory geometry
   instance; keep parse + prepass + decode serial (or in their current form) and
   parallelize **only** the CSG-heavy boolean step across elements. This avoids
   the decode-thread penalty §12 hit and Amdahl-limits on a much smaller serial
   fraction. Recommended target after the naive bundle proves out in the viewer.

Either way it stays **one Rust source** — no second kernel, no drift (unlike
re-adding Manifold). Within-element `subtract()` is *not* parallelizable (single
`&mut Interner`); the granularity is across elements, which is genuinely
independent.

### Build: two bundles
- **Plain** (today's flags): the fallback for non-isolated contexts and Safari.
- **Threaded**: the spike flags (validated, `spike/path-b-respike` / `8fcaff96`):
  ```
  target-feature=+simd128,+atomics,+bulk-memory,+mutable-globals
  link-arg=--shared-memory --import-memory
  link-arg=--export=__wasm_init_tls,__tls_size,__tls_align,__tls_base
  + build-std=["std","panic_abort"] (already in .cargo/config.toml)
  + wasm-bindgen-rayon 1.3.0
  ```
  Select at runtime via `wasm-feature-detect` (threads support) **and**
  `self.crossOriginIsolated`.

### Required patch (raw-serve / wasm-bindgen-rayon)
`wasm-bindgen-rayon`'s `workerHelpers.js` does `import('../../..')` — a package
**directory**, which only resolves under a bundler. On a raw static server the
helper worker dies silently and the main thread awaits `ready` forever (presents
as an `initThreadPool` hang). The build must rewrite it to the explicit module
file, e.g. `import('../../../<out-name>.js')`, as a post-build step. (The viewer
is bundled by Vite, which resolves the directory import; the patch is required for
unbundled serving and worth applying defensively.)

### Cross-origin isolation
Already in place in production (`vercel.json`: COOP `same-origin` + COEP
`credentialless`), and SAB is already used for the file buffer. **Safari does not
support `credentialless`** → it is not cross-origin isolated → it must run the
plain bundle. That is the core reason two bundles ship.

## Projected production win

Amdahl on a void-heavy model (CSG ≈ 85–90% of load, ~4× on CSG at 8 threads,
serial parse/prepass/decode unthreaded): **~2.5–3× cold-load**. The measured
naive whole-pipeline 1.9× is the floor; the surgical split plus trimming the
~14 s serial prepass (separately tracked) approaches the projection. On
steel/faceted-brep-heavy models where *meshing* dominates rather than CSG, the
win is smaller — pair with the rect-fast path (do less CSG) and the brep-mesher
lever.

## Risks / costs
- Two bundles double WASM build + CI artifact surface; the plain fallback path
  must stay tested (Safari, non-isolated embeds).
- `-Zbuild-std` pins a nightly (already the repo's toolchain); a bump can break
  the std rebuild — pin deliberately.
- dlmalloc single global lock caps scaling ~10–25% below native; a sharded
  allocator is unreliable on `wasm32-unknown-unknown` (mimalloc-rust is dicey) —
  accept the cap for now.
- Memory: one shared instance must hold the largest model's working set within
  the 4 GB wasm32 address space (max-memory already 4 GB).

## Repro
Native: `cargo run --release -p ifc-lite-processing --example csg_scaling_bench --features csg-capture -- <model.ifc>`
WASM: build `rust/csg-thread-bench` plain + threaded (see crate header), serve
`web/` with COOP/COEP (`node serve.mjs`), open `index.html?pkg=threaded&mode=…`.

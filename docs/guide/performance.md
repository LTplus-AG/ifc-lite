# Performance

IFClite is designed to be fast and lightweight. This page covers bundle size, parsing speed, rendering performance, and how the architecture keeps things efficient.

## Bundle Size

The whole client-side engine (parser, exact CSG geometry kernel, and all Rust exporters) ships as a single WASM module of roughly 7.9 MB, about 2.6 MB gzipped over the wire (measured on the published `@ifc-lite/wasm` tarball: `npm pack @ifc-lite/wasm` then `gzip -9 -c pkg/ifc-lite_bg.wasm | wc -c`). It is loaded once, lazily, and cached by the browser. Optional heavyweight features stay out of the bundle: DuckDB-WASM for SQL queries is only downloaded on the first `sql()` call, and only if you install it.

You can reproduce the measurement with `scripts/measure-bundle-size.sh`.

## Parsing and Geometry

The streaming pipeline processes geometry in batches, so the first triangles appear on screen while the rest of the file is still being meshed. The batch size scales with file size (from about 100 meshes for small files up to a few thousand for very large ones) to balance first-paint latency against per-batch overhead.

Two properties of the pipeline dominate throughput:

- **Entity scanning is SIMD-accelerated** (memchr-based) in Rust, so the STEP walk itself is rarely the bottleneck on geometry-heavy files.
- **Exact CSG void-cutting is the dominant geometry cost** on models with many openings. IFClite uses one exact cut per opening; per-element budgets and watchdogs keep pathological models from hanging the pipeline.

### Viewer Benchmark Reference

These numbers are stamped from the committed benchmark baseline so they cannot drift from what CI actually records. The two largest fixtures are optional stress tests and should be fetched on demand.

<!-- BEGIN GENERATED: perf-numbers -->
| Model | File size | Entities | Meshes | Total load | Recorded |
|-------|-----------|----------|--------|-----------|----------|
| AC20-FZK-Haus | 2.4 MB | 44,249 | 317 | 3.3 s | 2026-07-01 |
| 01_Snowdon_Towers_Sample_Structural(1) | 8.3 MB | 147,142 | 17,380 | 3.7 s | 2026-07-01 |
| ISSUE_053_20181220Holter_Tower_10 | 169.2 MB | 2,807,815 | 108,551 | 11.0 s | 2026-02-21 |
| O-S1-BWK-BIM architectural - BIM bouwkundig | 326.8 MB | 4,411,807 | 39,146 | 11.9 s | 2026-02-21 |

Source: `tests/benchmark/baseline.json`, the committed viewer-benchmark regression baseline. Rows recorded on 2026-07-01 come from the CI runner (GitHub Actions `ubuntu-latest`, headless Chrome + SwiftShader, production build); earlier rows are reference runs on faster local hardware, so the two groups are not directly comparable. Refresh with `pnpm docs:generate` after recording a new baseline.
<!-- END GENERATED: perf-numbers -->

## Zero-Copy GPU Pipeline

The rendering pipeline avoids unnecessary memory copies between WASM and the GPU:

- **Direct WASM-to-WebGPU transfer**: Geometry buffers go straight from WASM linear memory to GPU buffers
- **60-70% reduction** in peak RAM usage compared to a copy-based approach
- **74% faster** parse time with the optimized data flow
- **40-50% faster** geometry-to-GPU pipeline

## On-Demand Property Extraction

When using `@ifc-lite/parser` in the browser, properties are not all parsed upfront. Instead:

- Properties and quantities are extracted lazily when you access them
- The initial parse skips expensive property table building
- Large files (100+ MB) stream geometry while data loads in the background
- This keeps the UI responsive even for very large models

## Architecture Choices That Matter

These design decisions have the biggest impact on performance:

- **Streaming first**: Geometry is parsed and rendered incrementally. You see the model building up, not a loading spinner followed by everything at once.
- **Web Workers**: When the browser supports cross-origin isolation and SharedArrayBuffer, the data model parses in a dedicated Web Worker; it only falls back to the main thread when SharedArrayBuffer is unavailable. Geometry is meshed by a pool of workers for files of any size, with the pool size chosen by job count and available memory rather than a fixed file-size threshold.
- **Columnar storage**: Data is stored by type (IDs, types, names as separate arrays) for cache-efficient access patterns.
- **Zero-copy ArrayBuffer transfer**: Buffers are transferred between worker and main thread, not copied.

## Client vs Server Performance

| | Client (WASM) | Server (Rust) |
|---|---|---|
| **Threading** | Single-threaded | Multi-threaded (Rayon) |
| **Memory** | WASM 4 GB limit | System RAM |
| **Caching** | Browser IndexedDB | Content-addressable disk cache |
| **Format** | Raw geometry | Apache Parquet (15-50x smaller) |
| **Best for** | Privacy, offline, simple apps | Teams, large files, production |

For large files or team scenarios, the server processes everything in parallel and caches the result. Repeat visits skip parsing entirely.

## Running Benchmarks

You can run the benchmarks on your own hardware. Fixtures are fetched on demand from a GitHub Release (see `tests/models/manifest.json`; the repo no longer uses Git LFS):

```bash
pnpm --filter viewer build
node scripts/fixtures/fetch-fixtures.mjs "ara3d/AC20-FZK-Haus.ifc"
VIEWER_BENCHMARK_FILES="tests/models/ara3d/AC20-FZK-Haus.ifc" pnpm test:benchmark:viewer
```

For the large stress fixtures such as `BWK-BIM` and `Holter Tower`, fetch those files explicitly before running the benchmark suite:

```bash
node scripts/fixtures/fetch-fixtures.mjs "various/O-S1-BWK-BIM architectural - BIM bouwkundig.ifc" "ara3d/ISSUE_053_20181220Holter_Tower_10.ifc"
```

Results are saved to `tests/benchmark/benchmark-results/` with automatic regression detection. See the [benchmark README](https://github.com/LTplus-AG/ifc-lite/tree/main/tests/benchmark) for details on test models, metrics, and CI integration.

## Perf ratchet ceilings

Some performance numbers are deterministic enough to block a merge on: byte sizes, structural counts, instruction counts. Those are held by a ratchet. Each family keeps its ceilings in `tests/perf-ratchets/<family>.json`, and the `Perf ratchet ceilings` job in `test.yml` fails a PR when a measured value goes above its ceiling plus tolerance. Families: `native-instructions` and `native-instructions-large` hold callgrind instruction counts per pipeline phase (`scripts/perf/instructions.sh`, tolerance 0.05%) for FZK-Haus (every Rust-affecting PR) and ISSUE_129 (daily lowering job only, about 2.5 minutes under callgrind); they gate kernel and parse work, not scheduling or browser effects. The first family is `bundle`: the brotli size (quality 11) of the engine WASM, of the viewer's main entry chunk, and of every JS file `index.html` loads eagerly (`viewer-eager-js-brotli`), plus the number of those files (`viewer-eager-js-chunks`).

**Reading a ceiling.** Each entry has an `id`, the `metric` it measures, the `ceiling`, a `tolerance`, and `provenance` (the `main` commit and time it was measured at). An `exact` tolerance means any rise fails, which is used for structural counts. A `relative` tolerance of `0.005` allows up to 0.5% above the ceiling. That band is total slack, not a per-PR allowance: the ceiling does not move when a PR lands inside it, so several small rises still fail once together they cross it. When the check fails, the job summary (and a sticky PR comment) shows a table of every metric that moved, with ceiling, allowed maximum, measured value and the change.

**Lowering is automatic.** `.github/workflows/perf-ratchet-lower.yml` runs daily on `main`, rebuilds and re-measures, and opens or updates one PR that lowers every ceiling whose value dropped (for a `relative` metric, once the drop clears the tolerance band, so build noise does not open a PR every day). Those PRs reference the standing issue #6955 and list each change, old to new. If a later run finds that nothing clears its band any more, it closes the open lowering PR rather than leaving an outdated ceiling to be merged.

The job opens PRs with the repository secret `PERF_RATCHET_PAT`, never `GITHUB_TOKEN`, because PRs that token creates do not start CI. It also never uses `RELEASE_PAT`, because RELEASE.md requires the release account to be used by nothing else. To set it up, create a fine-grained PAT from an account separate from the `RELEASE_PAT` account. Scope it to this repository only, with **Contents: Read and write** and **Pull requests: Read and write**. **Workflows: Read and write** is also needed when the lowering branch, which is reset onto `main`, carries workflow changes. Store it as `PERF_RATCHET_PAT`. Without it, the job still measures and lowers. It writes the old-to-new table to its summary, uploads the lowered files as the `perf-ratchet-lowered-ceilings` artifact, warns that no PR was opened, and stays green.

**Raising is a human decision.** If a PR has to grow a metric, edit the entry in `tests/perf-ratchets/<family>.json` in that PR: set `ceiling` to the new measured value and `provenance` to the commit you measured, and justify the cost in the PR description (what grew, why it is worth it, what was tried to avoid it). Never widen `tolerance` to make a breach pass. Reproduce the CI measurement locally with:

```bash
pnpm build:wasm && pnpm build:e2e
node scripts/perf-ratchet/measure-bundle.mjs --out /tmp/bundle.json
node scripts/perf-ratchet/perf-ratchet.mjs check --measured /tmp/bundle.json
```

**When `viewer-eager-js-brotli` fails.** That metric is the total brotli size of every JS file `dist/index.html` makes the browser fetch before first paint: the module `<script src>` plus each `<link rel="modulepreload">`, each file compressed on its own, as a static host would serve it. A failure means the PR put more code on the boot path. The job summary table shows how many bytes; the `detail` of `viewer-eager-js-chunks` in the measured JSON lists the files. Pick one of two fixes:

1. **Lazy-load the new code.** This is the default answer. A feature that is not needed to show the first frame belongs behind a dynamic `import()` (a panel, a dialog, an exporter, a tool that opens on click), so it ships in a chunk `index.html` does not list. Check afterwards that nothing eager imports it statically, which pulls it straight back in: re-run the local measurement above and compare the file list.
2. **Raise the ceiling, with a reason.** If the code really has to be eager, edit the `viewer-eager-js-brotli` entry as described under "Raising is a human decision" and say in the PR what the code does at boot, why it cannot wait, and what you tried. Do not widen `tolerance`.

`viewer-eager-js-chunks` counts the same files and is a looser companion: its ceiling is the measured count, and its `relative` tolerance of 3.5% admits about five more files at the current count. Ordinary Vite chunk splitting moves a count without changing the bytes shipped, so a small rise there is not a regression, and the byte ceiling is what blocks. If the count check fails, the build split into many more files than before. Look for a barrel import or a shared module that began to be pulled in by several entry points, and fix that instead of raising the count.

A local build embeds different source paths in the WASM than CI does, so expect small differences; the CI job's summary is the number that counts. Adding a family means adding a `scripts/perf-ratchet/measure-<family>.mjs` that writes the measured JSON, a seeded ceiling file, and a measure step in CI and in the daily workflow.

## Further Reading

- [Architecture Overview](../architecture/overview.md) for system design and data flow
- [Rendering Guide](rendering.md) for WebGPU pipeline details
- [Server Guide](server.md) for server-side processing and caching

### Cache write compression

The viewer runs geometry cache compression in a browser module worker. SDK callers can enable the same behavior with `BinaryCacheWriter.write` option `compressGeometryChunksInWorker: true`; its default remains `false` for workerless environments. The cache format and compression rules are unchanged. A browser must bundle and permit the worker asset; worker failures reject the cache write. Cold-load qualification includes cache completion because off-main compression still consumes CPU.

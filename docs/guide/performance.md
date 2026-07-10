# Performance

IFClite is designed to be fast and lightweight. This page covers bundle size, parsing speed, rendering performance, and how the architecture keeps things efficient.

## Bundle Size

The whole client-side engine (parser, exact CSG geometry kernel, and all Rust exporters) ships as a single WASM module of roughly 3.4 MB, about 1.2 MB gzipped over the wire. It is loaded once, lazily, and cached by the browser. Optional heavyweight features stay out of the bundle: DuckDB-WASM for SQL queries is only downloaded on the first `sql()` call, and only if you install it.

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

## Further Reading

- [Architecture Overview](../architecture/overview.md) for system design and data flow
- [Rendering Guide](rendering.md) for WebGPU pipeline details
- [Server Guide](server.md) for server-side processing and caching

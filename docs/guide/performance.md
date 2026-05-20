# Performance

IFClite is designed to be fast and lightweight. This page covers bundle size, parsing speed, rendering performance, and how the architecture keeps things efficient.

## Bundle Size

| Library | WASM Size | Gzipped |
|---------|-----------|---------|
| **IFClite** | **0.65 MB** | **0.26 MB** |
| web-ifc | 1.1 MB | 0.4 MB |
| IfcOpenShell | 15 MB | - |

## Parsing and Geometry

Geometry processing is up to 5x faster overall (median 2.18x across test files, up to 104x on specific models). The streaming pipeline processes geometry in batches of 100 meshes so the first triangles appear on screen while the rest of the file is still being parsed.

### Viewer Benchmark Baseline (2026-02-21)

Measured locally with the viewer benchmark suite on an M1 MacBook Pro. The two largest fixtures are optional stress tests and should be fetched on demand:

| Model | Size | First Geometry | Total Time | Meshes |
|-------|------|----------------|------------|--------|
| FZK-Haus | 2.4 MB | ~202 ms | ~0.25 s | 244 |
| Snowdon Towers | 8.3 MB | ~217 ms | ~0.59 s | 1,556 |
| BWK-BIM | 326.8 MB | ~5.43 s | ~11.89 s | 39,146 |
| Holter Tower | 169.2 MB | ~3.05 s | ~11.04 s | 108,551 |

### End-to-End Viewer Loading

Full loading times including parsing, geometry processing, and rendering:

| Model | Size | Entities | Total Load | First Batch | Geometry (WASM) | Data Model Parse |
|-------|------|----------|------------|-------------|-----------------|------------------|
| Large architectural | 327 MB | 4.4M | **11.9 s** | 5.43 s | 2.98 s | 3.16 s |
| Tower complex | 169 MB | 2.8M | **11.0 s** | 3.05 s | 5.60 s | 2.07 s |
| Small model | 8.3 MB | 147K | **0.59 s** | 217 ms | 292 ms | 110 ms |

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
- **Web Workers for large files**: Files over 50 MB are processed in a dedicated worker. Geometry streams from the worker while the data model parses on the main thread.
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

You can run the benchmarks on your own hardware:

```bash
pnpm --filter viewer build
git lfs pull --include="tests/models/ara3d/AC20-FZK-Haus.ifc"
VIEWER_BENCHMARK_FILES="tests/models/ara3d/AC20-FZK-Haus.ifc" pnpm test:benchmark:viewer
```

For large stress fixtures such as `BWK-BIM` and `Holter Tower`, fetch those files explicitly with `git lfs pull --include=...` before running the benchmark suite.

Results are saved to `tests/benchmark/benchmark-results/` with automatic regression detection. See the [benchmark README](https://github.com/LTplus-AG/ifc-lite/tree/main/tests/benchmark) for details on test models, metrics, and CI integration.

## Further Reading

- [Architecture Overview](../architecture/overview.md) for system design and data flow
- [Rendering Guide](rendering.md) for WebGPU pipeline details
- [Server Guide](server.md) for server-side processing and caching

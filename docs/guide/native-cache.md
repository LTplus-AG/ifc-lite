# Native Cache Builder

`ifc-build-cache` builds the binary `.ifclite` cache of an IFC file natively, outside the browser, in the format `@ifc-lite/cache` reads (format v28). A server, a build step or a function can prepare the cache once, and a browser then only downloads and reads it with `BinaryCacheReader` instead of parsing and tessellating the model itself.

The format is specified in [`packages/cache/SPEC.md`](https://github.com/LTplus-AG/ifc-lite/blob/main/packages/cache/SPEC.md). The native writer lives in the `rust/cache` crate (`ifc-lite-cache`) and runs the canonical Rust processing pipeline (`ifc-lite-processing`); it adds no ingest or geometry of its own.

## Installation

The tool is distributed through cargo from this repository; there are no prebuilt binaries.

```bash
cargo install --locked --path rust/cache
```

## Usage

```bash
ifc-build-cache model.ifc model.ifclite
```

| Flag | `BinaryCacheWriter` option | Effect |
|------|----------------------------|--------|
| `--no-geometry` | `includeGeometry: false` | Write the data sections only |
| `--omit-source-hash` | `omitSourceHash: true` | Store a zero source hash and set the `SourceHashUnset` header flag |
| `--no-compress` | `compressGeometryChunks: false` | Store every geometry chunk raw instead of deflating large ones |

On success it prints the build's statistics as one JSON object on stdout (`entityCount`, `meshCount`, `chunkCount`, `cacheBytes`, `chunkCells`, `peakOpenChunkBytes`, ...) and exits 0. A usage error exits 2; any other failure exits 1 with the reason on stderr.

## Guarantees

- **Deterministic.** The output is a pure function of the input bytes and the flags: the same file gives the same bytes on every run and every thread count.
- **One output, two writers.** The CLI streams; the library's in-memory `build_cache` builds the same file in RAM. The two are byte-identical (`rust/cache/tests/streamed_matches_in_memory.rs`), and `scripts/cache-native-conformance.mjs` checks both against the TypeScript reader and writer.
- **Atomic.** The cache is written to a temporary file in the output's directory, synced, and renamed over the output. If the build fails, the output is untouched (an existing file keeps its old contents) and no temporary or spool file is left behind.
- **Bounded offsets.** Section and chunk offsets in the format are 32-bit, so a cache past 4 GiB is refused with an error rather than written with wrapped offsets. The streaming writer refuses as soon as the geometry it has written crosses the bound.

## Memory

The geometry pass runs with mesh retention off. Meshes are grouped into chunks by a 32 m grid cell as they are emitted, in the same canonical order the in-memory writer uses. A chunk closes when it would pass the 8 MiB soft cap or when the pass ends; each closed chunk is serialized (and deflated when that is smaller) and appended to a spool file next to the output, and only its 44-byte directory entry stays in memory. When the pass ends, the header, sections and directory are written to the temporary file and the spool is copied after them.

What the writer holds at once is therefore the data sections, one batch of jobs' meshes in the pipeline, and the open chunks: at most one per distinct grid cell, each under the soft cap plus one mesh. `chunkCells` times 8 MiB is that bound for a given model, and `peakOpenChunkBytes` is what the open chunks actually reached.

The input is memory-mapped rather than copied onto the heap. That keeps the source pages file-backed and reclaimable, but it does not by itself bound resident memory: the pages the parser touches still count, as do the entity index, strings and data model.

## What a native cache leaves out

Every one of these is a value the format and the TypeScript reader already accept:

- Property and quantity tables are written empty, as `BinaryCacheWriter` writes them for a STEP-parsed store; re-attach on-demand extraction from the source on read, as the viewer does.
- No `InstancedShards` section: every occurrence is a flat mesh.
- Deflate streams differ from the TypeScript writer's (a different compressor), so stored chunk offsets and lengths differ while every uncompressed chunk payload is identical.

The crate documentation (`rust/cache/src/lib.rs`) lists the remaining producer-provenance fields the native pipeline does not fill.

## From Rust

```rust
use ifc_lite_cache::{build_cache_to_path, CacheOptions};

let source = std::fs::read("model.ifc")?;
let stats = build_cache_to_path(&source, "model.ifclite".as_ref(), CacheOptions::default())?;
println!("{} meshes in {} chunks", stats.mesh_count, stats.chunk_count);
```

`build_cache(&source, options)` returns the same bytes as a `Vec<u8>` when you need the cache in memory rather than on disk.

# Native Cache Builder

`ifc-build-cache` builds the binary `.ifclite` cache of an IFC file natively, outside the browser, in the format `@ifc-lite/cache` reads (format v28). A server, a build step or a function can prepare the cache once, and a browser then only downloads and reads it with `BinaryCacheReader` instead of parsing and tessellating the model itself.

The format is specified in [`packages/cache/SPEC.md`](https://github.com/LTplus-AG/ifc-lite/blob/main/packages/cache/SPEC.md). The native writer lives in the `rust/cache` crate (`ifc-lite-cache`) and runs the canonical Rust processing pipeline (`ifc-lite-processing`); it adds no ingest or geometry of its own.

## Installation

The tool is distributed through cargo from this repository; there are no prebuilt binaries, and the crate is not published to crates.io.

From a checkout:

```bash
cargo install --locked --path rust/cache
```

Without a checkout, pinned to a commit:

```bash
cargo install --locked --git https://github.com/LTplus-AG/ifc-lite --rev 58d278b3b88e4484ccef336f024b4ca1051dd221 ifc-lite-cache
```

That revision writes format v28. To build a different one, replace the hash with any commit on `main` whose format version your readers accept (see [Reader compatibility](#reader-compatibility)); `FORMAT_VERSION` in `rust/cache/src/format.rs` at that commit is the version it writes.

Pin a commit rather than a branch: the commit decides which format version the tool writes (see [Reader compatibility](#reader-compatibility)), and `--locked` then builds it with the `Cargo.lock` of that commit.

A stable Rust toolchain builds the crate. The nightly pinned in `rust-toolchain.toml` is for the WASM build; rustup selects it only for commands run inside a checkout, so the `--git` form uses your default toolchain.

## Reader compatibility

`BinaryCacheReader` rejects a cache whose format version is above its own `FORMAT_VERSION`, with `Unsupported format version`. That check is an upper bound, not a promise that every older cache decodes: [`SPEC.md` §11](https://github.com/LTplus-AG/ifc-lite/blob/main/packages/cache/SPEC.md#11-reader-compatibility-current-reader) lists what a cache from an older format version reads as, and which ones the reader refuses or misreads. The tool writes one format version, that of the commit it was built from, and `ifc-build-cache --help` prints it.

Build the tool from a commit whose format version is not above the `FORMAT_VERSION` that the `@ifc-lite/cache` release in your readers exports. When a format version bump reaches you, upgrade the readers first, then the tool.

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
- **Atomic.** The cache is written to a temporary file in the output's directory, synced, and renamed over the output. If the build fails before the rename, the output is untouched (an existing file keeps its old contents). A build that fails with an error removes its temporary and spool files. A build that is killed (SIGTERM, SIGKILL, out of memory) or panics (the release profile aborts on panic) cannot clean up, and leaves `.<output name>.<pid>.<n>.tmp` and `.<output name>.<pid>.<n>.spool` beside the output; the spool can be several MB. These never replace the output, a later build picks unused names instead of failing on them, and they are safe to delete once no build is running. The one exception is syncing the directory after the rename (Unix): if that fails, the build reports the error but the output already holds the complete new cache, though the rename may not yet be durable across a crash.
- **Bounded offsets.** Section and chunk offsets in the format are 32-bit, so a cache past 4 GiB is refused with an error rather than written with wrapped offsets. The streaming writer refuses as soon as the geometry it has written crosses the bound.

## Memory

The geometry pass runs with mesh retention off. Meshes are grouped into chunks by a 32 m grid cell as they are emitted, in the same canonical order the in-memory writer uses. A chunk closes when it would pass the 8 MiB soft cap or when the pass ends; each closed chunk is serialized (and deflated when that is smaller) and appended to a spool file next to the output, and only its 44-byte directory entry stays in memory. When the pass ends, the header, sections and directory are written to the temporary file and the spool is copied after them.

What the writer holds at once is therefore the data sections, one batch of jobs' meshes in the pipeline, and the open chunks: at most one per distinct grid cell, each under the soft cap plus one mesh. For a given model the bound is per cell: each of the `chunkCells` cells holds under 8 MiB plus at most one more mesh, of any size (a mesh is never split, so the mesh that crosses the cap is added before its chunk closes). It is therefore `chunkCells` times 8 MiB plus the largest mesh in each cell, and `peakOpenChunkBytes` is what the open chunks actually reached.

The input is memory-mapped rather than copied onto the heap. That keeps the source pages file-backed and reclaimable, but it does not by itself bound resident memory: the pages the parser touches still count, as do the entity index, strings and data model.

## What a native cache leaves out

Every one of these is a value the format and the TypeScript reader already accept:

- Property and quantity tables are written empty, as `BinaryCacheWriter` writes them for a STEP-parsed store; re-attach on-demand extraction from the source on read, as the viewer does.
- No `InstancedShards` section: every occurrence is a flat mesh.
- The entity index's relationship-coverage trailer is written absent, so `selectionRelationshipIndex` reads back `undefined`, as it does for any store built without it.
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

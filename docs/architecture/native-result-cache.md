<!-- This Source Code Form is subject to the terms of the Mozilla Public
     License, v. 2.0. If a copy of the MPL was not distributed with this
     file, You can obtain one at https://mozilla.org/MPL/2.0/. -->

# Native result cache

Opening the same IFC file twice through the Rust core used to recompute everything.
`ifc_lite_processing::result_cache` adds an opt-in, on-disk cache of complete
processing results for native callers. It is off by default. Phase 1 serves the
Rust API and `perf_probe` only. FFI, Python, the server and CLI flags are later
phases.

## What is cached

One tier: the complete result of a full pass. On a completed pass,
`ResultCache::process(content, &request)` stores the exact `ProcessingResult`:

- every mesh in order, with positions, normals, indices, colour, UVs, texture pixels
  or URL, text metadata, properties, ids, geometry class and origin
- the in-memory fields that serde skips: `instance`, `local_bounds`,
  `local_to_world` and `presentation`
- instance records, the mesh frame, the site and building transforms
- model metadata, including the unit scale or refusal and georeferencing
- every `ProcessingStats` counter and the full `GeometryDiagnostics`

Floats are stored as raw IEEE bits, so `-0.0` and NaN payloads survive. Texture
pixels that meshes share in one `Arc` are stored once and shared again on replay.

A later call with the same source bytes, the same output-affecting request and the
same engine replays the stored result instead of processing. The replay sets
`stats.from_cache = true`. Its `*_time_ms` fields are the producer's, kept verbatim.
They are not the replaying call's work. That work is reported separately in
`CacheReport.work`: hash, read, validate and decode time, with byte counts.

The prepared-source tier (entity index and discovery spans for a miss) is not part
of phase 1.

## When it does not apply

| Situation | Outcome |
| --- | --- |
| `CacheMode::Off` (the default) | `Off`: calls `process` directly. Nothing is hashed or opened. |
| A cancellable request (`cancel` set) | `Bypass(CancellationArmed)` |
| An injected `entity_index` (not verified against the bytes) | `Bypass(InjectedEntityIndex)` |
| `retain_meshes == false` | `Bypass(MeshesNotRetained)` |
| Cache directory missing (read-only), unusable or not private | `Miss(Absent)` or `Bypass(Unavailable)`, plus a warning |
| Streaming or callback consumers | They keep calling `process(content, request, sink)`. The cached entry point takes no sink, so no sink event can go missing on a hit. |

A bypass or a miss runs the unchanged pipeline. `process` itself does no I/O.

## Keys

```text
key = SHA-256( "ifc-lite-native-result-v1"
             ‖ SHA-256(all source bytes) ‖ len(source)
             ‖ request digest ‖ engine digest )     every part length-framed
```

- **Source.** Every byte the pass reads, never a sample. A one-digit edit in the
  middle of a file misses (tested).
- **Request.** A canonical encoding of every `ProcessingRequest` field with explicit
  tags: opening filter, `skip_voids`, quality, layer slicing, all batching fields
  (including `fast_first`), all four feature flags and instancing. The ID filter
  sorts its ids, and `None` differs from `Some(empty)`. The request struct is
  destructured in full, so a new field does not compile until someone classifies it.
- **Engine.** `build.rs` digests the sources of `ifc-lite-core`, `-geometry` and
  `-processing`, plus `Cargo.lock`, the rustc version, the target, the profile, the
  rustc flags, the target features and the enabled features. The entry format
  version is mixed in at runtime. So is every `IFC_LITE_*` / `IFCLITE_*`
  environment variable except `IFC_LITE_CACHE_DIR` and `IFC_LITE_REQUIRE_FIXTURES`,
  because `IFC_LITE_RECT_FAST`, `IFC_LITE_VOID_2D` and others change geometry at
  runtime. This is deliberately conservative: any rebuild of the engine misses.
  Relaxing the key to explicit revisions needs x86_64/arm64 determinism evidence.

## Entry format

The entry is a sectioned little-endian envelope (`envelope.rs`):

- a 200-byte header: magic, format version, total length, key, source digest and
  length, request and engine digests, and a SHA-256 over the header and directory
- a four-entry directory: kind, offset, length, record count and SHA-256 for each
  section
- the sections META, TEXTURES, MESHES and INSTANCES, back to back

There is no compression, no `usize`, no serde ordinals and no memory casts.

## Trust model

Entries are untrusted input. Every length, offset and count is checked with
overflow-safe arithmetic before anything is allocated. Each count must fit in the
remaining bytes at the record's minimum encoded size. Sections must appear in a
fixed order, contiguous, with no overlap, gap or trailing bytes. Every section's
checksum is verified before any section is decoded. Booleans, option tags and enum
tags accept only defined values. Strings must be UTF-8. The decoded result must
pass the same invariants the encoder enforced: whole triples, indices within the
vertex count, texture size, coordinate space matching the frame, and instance
templates present. Any failure produces a warning and a miss, and the pipeline
recomputes. There is no panic and no partial result. The tests cover truncation at
every byte, every single-byte flip, overflowing counts and lengths, forged
overlapping sections, wrong digests, dangling references and 4,000 seeded mutations
that are re-sealed past the checksums.

**Limit.** A checksum detects damage, not authorship. A process running as the same
user can write a self-consistent entry with wrong geometry, and the cache cannot
tell. Phase 1 relies on a private per-user directory: 0700 directories and 0600
files, owner and permission checks on every opened file, `O_NOFOLLOW`, and file
names made only of the digest. An environment that needs more than that needs
authenticated entries or a separate trusted writer. On non-Unix targets the
symlink check is a racy metadata check.

## Store, policy and concurrency

The default root is `IFC_LITE_CACHE_DIR`, else the platform cache directory
(`$XDG_CACHE_HOME` or `~/.cache`, then `ifc-lite/native`; on macOS
`~/Library/Caches/ifc-lite/native`; on Windows `%LOCALAPPDATA%\ifc-lite\native`).
Entries live in `<root>/result-v1/<key>.ifcr`.

- **Publication.** The writer takes the key's advisory lock without waiting (a busy
  lock means another process is writing the same result, so this one skips). It
  rechecks for an identical entry, writes a temp file, fsyncs it, renames it into
  place and fsyncs the directory. Readers see the old file or the new one, never a
  prefix.
- **Crash.** A writer that dies before the rename leaves a `.tmp` file that no
  reader opens. A later eviction pass removes it once the key's lock is free.
- **Corruption.** A corrupt entry is removed only if it is still the generation that
  was read, so a concurrent repair is never deleted.
- **Budget.** The limits are 10 GiB per directory and 1 GiB per entry, and a write
  must leave at least 1 GiB free. These are policy choices, not measured optima.
  Over budget, after a publish, the least recently used entries are evicted (by
  mtime, which each read-write hit refreshes) down to 90 % of the budget. Eviction
  runs only on publish, never on lookup.
- **Failure.** Disk and permission errors fail open: a warning, then the live
  result.

## Measuring a warm hit

```sh
cargo build --profile profiling -p ifc-lite-processing --example perf_probe
P=target/profiling/examples/perf_probe
$P model.ifc --cold --result-cache /tmp/rc --expect-cache miss --result-fingerprint --json
$P model.ifc --cold --result-cache /tmp/rc --expect-cache hit  --result-fingerprint --json
```

The second run is a fresh process. Its `resultCache` object reports the hash, read,
validate and decode work and the bytes it touched. Its phase table is the
producer's (`statsAreProducers: true`). The two `resultFingerprint` values must be
equal.

## Remaining phases

1. The prepared-source tier: index and discovery spans, to speed up a miss.
2. FFI and Python: versioned config entry points that leave existing ABIs alone,
   with hashing done while Python's GIL is released.
3. Server layering: a core snapshot behind the existing HTTP cache, with the core
   engine identity propagated into its outer keys.
4. CLI flags (`--cache-dir`, `--no-cache`) where a native backend actually runs.
5. Replayable sink events for streaming consumers.
6. Relaxing the engine key from build identity to explicit revisions once
   cross-architecture determinism evidence exists.

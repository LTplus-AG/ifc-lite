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
| The calling thread is inside an `ExecutionAccount` scope, a source stop or a terminal domain | `Bypass(AmbientResourceScope)`: such a scope can refuse or degrade products, so neither a hit nor a stored result would be its output |
| Read-only mode and the cache directory does not exist yet | `Miss(Absent)`, silently (an empty cache is not an error) |
| Cache directory unusable or not private, or the executable identity unreadable | `Bypass(Unavailable)`, plus a warning |
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
- **Engine, build.** This part covers three things:
  - The `build.rs` digest: the sources of `ifc-lite-core`, `-geometry` and
    `-processing`, `Cargo.lock`, the rustc version, the target, profile and flags,
    the target features, and processing's own features.
  - The geometry crate's own resolved features,
    `ifc_lite_geometry::output_policy::BUILD_FEATURES`. A downstream binary can
    enable `ifc-lite-geometry/csg_topology_gate` without changing processing's
    features; a geometry test keeps that list equal to its `Cargo.toml`.
  - The running executable file's identity: size, mtime, ctime, device and inode,
    without the path. `touch`, `cp -p` and `utime` cannot restore ctime, so an
    in-place edit that restores mtime still changes it. This is metadata, not
    a content hash. It identifies the binary that statically links the engine.
    A future FFI or Python consumer, where `current_exe` is the host, needs an
    identity embedded in the engine library; that is a stated prerequisite for
    those phases.

  So a developer who changes kernel output invalidates every entry in two
  independent ways. The source edit changes the build digest, and the rebuilt
  binary changes the executable identity. A relink that only changes third-party
  feature unification is caught by the executable identity alone.
- **Engine, policy.** This is the *effective* process-global output policy, read
  through the same accessors the pipeline calls:
  `ifc_lite_geometry::output_policy::effective_output_policy` (rect fast and
  parametric paths, local frame, void union / 2D / prism paths, extra dedup, the
  half-space cap, the fast-cut ratio, the effective per-boolean and per-element CSG
  caps, the alternate triangulator), plus processing's degenerate backstop and the
  calling thread's rayon worker count. It is never the raw environment. Most knobs
  cache their environment variable in a `OnceLock` on first use, and several have
  programmatic overrides (`local_frame_set_enabled_override`, `budget::set_cap`,
  ...). Hashing the environment let a process that set `IFC_LITE_LOCAL_FRAME=1`
  after the policy was cached write a non-local-frame entry under the
  local-frame key (PR #9614 review). Environment knobs are read once per process
  (`OnceLock`), so they cannot change during a pass. Every programmatic setter
  bumps a mutation generation before and after its store, seqlock style
  (`output_policy::policy_generation`). The policy is read between two equal,
  even generations. A pass whose generation moved is not stored
  (`SkippedPolicyChanged`), even if the value was set back before the pass ended
  (A → B → A; second review). A hit whose generation moved while it was read is
  dropped (`Miss(PolicyChangedDuringLookup)`). The pass itself still reads the
  live globals, so an uncached pass during a setter can mix policies as before;
  the cache only refuses to store or replay it.
  `tests/result_cache_policy_ratchet.rs` fails on any `IFC_LITE_*` name that is
  neither keyed nor listed as non-output. The non-output list is
  `IFC_LITE_CACHE_DIR` (it only chooses where entries live) and
  `IFC_LITE_ENGINE_BUILD_DIGEST` (a compile-time `env!` set by `build.rs` to the
  build digest, which is itself keyed). The ratchet also fails if any router on
  the cached pass pins an explicit frame policy (`RouterConfig::local_frame`),
  which would bypass the keyed process-wide fallback. It also fails on any change in the
  number of environment access sites per file in core, geometry and
  processing, so a read under any other name has to be reviewed as well.
- **Engine, execution.** This is the calling thread's rayon worker count. No mesh
  output is known to depend on it. It is keyed because that independence has not
  been shown across pool sizes, and keying it only costs hits between
  differently sized pools. Point-cache hit/miss counters do depend on
  scheduling. Like timings, they are the producer's values, replayed verbatim.
- **Resource stops.** The pass itself records whether any of its jobs started on
  a thread carrying resource state it did not install. That covers another
  caller's account through a stolen job, and a worker still in a stopped
  terminal domain that refuses products without a new stop (third review). Such a
  pass is not stored (`SkippedResourceStop`). As a second net, every
  `resource::stop` in the process is counted (`resource::stop_events`), and a pass
  during which the count moved is not stored either.
- **Scan reports.** The scan reports refused records and malformed files through
  core's `set_report_sink` callback, outside `ProcessingSink`. A hit never scans,
  so it would drop that warning. Core counts emissions
  (`ifc_lite_core::scan_report_events`), and a pass during which one was emitted
  is never stored (`SkippedScanReported`), so every call for such an input
  delivers it. Replaying the messages instead would need per-pass capture of a
  process-global callback that concurrent passes share; that is left for when
  malformed inputs need caching.
- **Concurrent setters.** Writers are serialised across both generation bumps and
  the store, so the generation is odd exactly while a store is in progress, even
  with overlapping setters (third review). This catches a product refused under an unrelated
  scope, for example a rayon job stolen by another caller's thread. It is
  conservative: any stop anywhere skips the store.

  Keying on the build is deliberately conservative: any rebuild misses. Relaxing
  it to explicit revisions needs x86_64/arm64 determinism evidence.

## Inputs and channels: complete inventory

This table lists everything that can change what `ResultCache::process` returns, or what a caller observes, and how each item is handled. A hit must be indistinguishable from the live run on every channel listed as replayed or keyed. Tests are in `rust/processing/tests/` unless marked `(unit)`.

### Inputs

| Input | Kind | Handling | Pinned by |
| --- | --- | --- | --- |
| Source bytes (all of them) + length | request | **Keyed** (SHA-256, never sampled) | `every_output_affecting_input_misses` (mid-file digit, appended byte) |
| `opening_filter`, `skip_voids`, `quality`, `layer_slicing`, `batching.{initial,throughput,fast_first}`, `features.{properties,presentation_layers,quick_metadata_bootstrap,finishes}`, `instancing` | request | **Keyed** (explicit tags) | `every_output_affecting_input_misses` (15 variants) |
| `entity_ids` (`None` / `Some(empty)` / `Some(set)`) | request | **Keyed** (sorted; `None` ≠ empty) | same test (None vs `Some(empty)`, copied-entry identity mismatch) |
| `retain_meshes == false`, `entity_index`, `cancel` | request | **Ineligible** (`Bypass`) | `off_and_bypassed_requests_do_no_cache_work_and_match_the_pipeline` |
| A new `ProcessingRequest` field | request | **Compile error** until classified (exhaustive destructure) | compiler |
| 13 `IFC_LITE_*` / `IFCLITE_*` output knobs (rect fast and param, local frame, void union / 2D / prism, dedup extra, half-space cap, fast-cut ratio, CSG op and element budgets, alt triangulator, degenerate backstop) | env, read once | **Keyed** through the effective policy accessors, never by re-reading env | `an_output_affecting_environment_knob_misses_in_a_fresh_process`, `a_late_environment_change_cannot_poison_a_fresh_process`, `every_environment_knob_is_classified_for_the_result_cache` |
| A new environment read anywhere in core, geometry or processing | env | **Ratchet** (access sites counted per file) | `every_environment_access_site_is_reviewed` |
| `IFC_LITE_CACHE_DIR` | env | **Output-neutral** (location only) | ratchet `NOT_OUTPUT` |
| `IFC_LITE_ENGINE_BUILD_DIGEST` | compile-time `env!` | **Keyed** (it is the build digest) | ratchet `NOT_OUTPUT` |
| Setters `local_frame_set_enabled_override`, `rect_fast::param_set_enabled_override`, `set_build_dedup_extra_override`, `budget::set_cap`, `set_element_cap`, `set_alt_triangulator` | process global | **Keyed** (effective policy) | `effective_policy_overrides_are_keyed` |
| A setter while a pass runs or a hit is read (incl. A→B→A, overlapping writers) | process global | **Ineligible** (serialised seqlock generation) | `a_policy_change_undone_mid_pass_is_never_stored`, `overlapping_writers_never_expose_an_even_generation_mid_store` (unit), `a_panicking_store_still_closes_the_generation` (unit) |
| Explicit router `local_frame` | router config | **Not reachable** from the cached path (every router is `RouterConfig::default()` + keyed fields) | `the_cached_pass_never_pins_a_router_frame_policy` |
| Rayon worker count | execution | **Keyed** (conservative; no mesh dependence known) | — (phase 2 drops it after a pool-size matrix) |
| Caller-thread `ExecutionAccount` / source stop / terminal / owned observer | thread-local | **Ineligible** (`Bypass(AmbientResourceScope)`), both ways | `ambient_resource_scopes_bypass_the_cache_both_ways` |
| A job of the pass on a worker carrying foreign resource state (stolen job, pre-latched terminal stop) | thread-local, worker | **Ineligible** (decided per pass) | `a_worker_with_a_pre_latched_terminal_stop_never_stores_its_degraded_pass` |
| Any `resource::stop` anywhere during the pass | process global | **Ineligible** (second net) | `a_stop_during_the_pass_is_never_stored` |
| `analytic::with_source_capture` | thread-local | **Output-neutral** for `ProcessingResult` | `source_capture_and_the_progress_hook_are_output_neutral` |
| Kernel, core and processing source; `Cargo.lock`; rustc; target, profile, flags, target features; processing features | build | **Keyed** (`build.rs` digest, all three `src` trees watched) | cross-build qualification (gated rebuilds miss); revert mutants |
| Geometry resolved features | build | **Keyed** (`output_policy::BUILD_FEATURES`) | `build_features_list_every_cargo_feature` (unit), cross-build |
| Running executable file (size, mtime, ctime, device, inode; no path) | build | **Keyed** | `an_in_place_edit_with_restored_mtime_changes_the_identity` (unit) |
| Entry format version | build | **Keyed**; other versions → `Miss(Unsupported)` | `identity_and_version_mismatches_are_named` (unit) |

### Output channels

| Channel | Handling | Pinned by |
| --- | --- | --- |
| Every `ProcessingResult` field: meshes incl. serde-skipped fields, textures and sharing, instances, frame, transforms, metadata, stats, diagnostics | **Replayed bit for bit**. `from_cache` is set to `true`; `*_time_ms` and point-cache counters are the producer's values | `round_trip_preserves_every_field_bits_and_texture_sharing`, `fingerprint_sees_every_field`, `fingerprint_distinguishes_diagnostic_float_bits` (unit); corpus and heavy fresh-process equality |
| `ProcessingSink` events | **Not offered**: the cached entry point takes no sink | by construction |
| Core scan report sink (`set_report_sink`: refused ids, malformed file) | **Ineligible**: a pass that emits one is never stored, so every call keeps delivering it | `passes_that_report_scan_refusals_are_never_replayed_silently` |
| `progress::set_hook` heartbeat | **Output-neutral** liveness signal; a hit does no work and makes no ticks | `source_capture_and_the_progress_hook_are_output_neutral` |
| `tracing` events (e.g. the CSG failure summary) | **Not replayed**: diagnostics, not API. Their content is in the replayed stats and diagnostics; a hit logs the cache's own events | documented |
| CSG census, `csg_capture`, rect / prism / bool2d / opening-trace counters | **Not replayed**: measurement instrumentation drained by tools (`perf_probe --census`), not consumer output | documented |
| `CacheReport` (outcome, work, warnings) | **New channel**, current call only | integration tests |

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
tell. Phase 1 relies on a private per-user directory and file names made only of
the digest:

- **Files.** An entry or lock is opened only after `lstat` shows a regular file,
  with `O_NOFOLLOW | O_NONBLOCK`. The opened handle must still be that file (same
  device and inode), owned by the effective user, with no group or other
  permission bit (0600). A FIFO, socket, device, directory or symlink at an entry
  or lock path is refused without blocking.
- **Directories.** `result-v1` and `locks` are created 0700 and checked *by path*:
  a real directory, owned by the user, no group or other bits. Their ancestors
  are trusted and followed. A hostile writer of a parent directory can swap them;
  pinning a directory handle is a later hardening.

An environment that needs more than that needs authenticated entries or a separate
trusted writer. On non-Unix targets the file-type check happens by path before the
open, which a race can defeat, and the owner and mode checks are skipped.

## Store, policy and concurrency

The default root is `IFC_LITE_CACHE_DIR`, else the platform cache directory
(`$XDG_CACHE_HOME` or `~/.cache`, then `ifc-lite/native`; on macOS
`~/Library/Caches/ifc-lite/native`; on Windows `%LOCALAPPDATA%\ifc-lite\native`).
Entries live in `<root>/result-v1/<key>.ifcr`. Writers lock one of 256 permanent
stripes, `<root>/result-v1/locks/<first key byte>.lock`.

- **Locks.** Lock files are never unlinked or replaced, so everyone who opens a
  stripe locks the same inode. An earlier design kept one lock file per key and
  removed it with the entry. A writer that opened the lock before an eviction and a
  writer that opened the recreated file could then both hold "the" lock
  (PR #9614 review). Sharing a stripe can make a writer skip because an unrelated
  key is being stored. That costs a publication, never correctness.
- **Publication.** The writer takes the key's stripe without waiting (a busy stripe
  usually means another process is writing the same result, so this one skips). It
  rechecks for an identical entry, writes a temp file, fsyncs it, renames it into
  place and fsyncs the directory. Readers see the old file or the new one, never a
  prefix.
- **Crash.** A writer that dies before the rename leaves a `.tmp` file that no
  reader opens. A later eviction pass removes it after a minute, while holding the
  key's stripe, so no live writer can be between creating and renaming it.
- **Corruption.** A corrupt entry is removed only if it is still the generation that
  was read, so a concurrent repair is never deleted.
- **Budget.** The limits are 10 GiB per directory and 1 GiB per entry, and a write
  must leave at least 1 GiB free (`min_free_bytes`). These are policy choices, not measured optima.
  Over budget, after a publish, the least recently used entries are evicted (by
  mtime, which each read-write hit refreshes) down to 90 % of the budget. Eviction
  runs only on publish, never on lookup. The budget is approximate, not a hard
  quota. It ignores lock files, young temps, unrelated files and old namespaces.
  Concurrent writers can exceed it briefly. The size limit is checked after the
  result is encoded, so a skipped oversized result has still paid for one encoded
  copy. The free-space check is best effort and absent on non-Unix.
- **Size before encoding.** A result whose raw array and pixel payload alone
  exceeds the entry limit is refused before it is encoded. Otherwise the header
  and sections are written as separate buffers, never concatenated. The
  serialised size is roughly the result's own size, so a large result costs one
  serialised copy before the final size check. Allocation is infallible: an
  allocator failure aborts like any other pipeline allocation.
- **Crash consistency.** The temp file is fsynced before it is renamed, so a
  crash can lose a new entry but never leave a torn file under an entry name.
  Readers verify checksums regardless. The directory fsync is best effort, so
  `Published` means renamed, not guaranteed to survive power loss. A lost entry
  is a later miss. Locks and rename assume a local filesystem with coherent
  advisory locks; NFS and overlay mounts are untested.
- **Failure.** Disk and permission errors fail open: a warning, then the live
  result.

## Measuring a warm hit

```sh
cargo build --profile profiling -p ifc-lite-processing --example perf_probe
P=target/profiling/examples/perf_probe
$P model.ifc --cold --iters 1 --result-cache /tmp/rc --expect-cache miss --result-fingerprint --json
$P model.ifc --cold --iters 1 --result-cache /tmp/rc --expect-cache hit  --result-fingerprint --json
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

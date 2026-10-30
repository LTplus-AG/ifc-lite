<!-- This Source Code Form is subject to the terms of the Mozilla Public
     License, v. 2.0. If a copy of the MPL was not distributed with this
     file, You can obtain one at https://mozilla.org/MPL/2.0/. -->

# Browser streaming pre-pass memory (#8259)

This is allocation accounting from source, not a measured browser high-water
mark or a performance qualification. The failing production files are not
available as reproducible fixtures. No benchmark was run for this fix.

## Source ownership

Let `F` be source bytes, `N` entity rows, `J` geometry jobs, and `S` collected
support/styled/mapped spans. The host's SharedArrayBuffer holds `F` bytes outside
WASM. `viewSharedBytes` creates a JS view without copying, but wasm-bindgen's
`&[u8]` ABI still allocates and copies **all `F` bytes into linear memory** for
`buildPrePassStreaming` and its sharded/fingerprint variants. Rust borrows that
copy; it does not make a second source copy inside the streaming pre-pass.
Sharing an arbitrary JS SharedArrayBuffer as a Rust slice would require a
different parser/ABI: it is not the module's WebAssembly.Memory buffer.

The compatibility retry materializes another `F` bytes in JS, then marshals it
into WASM again. A trap already bypasses that retry. Geometry workers' shard
scan assists install `setSourceBytes(Vec<u8>)` once and use the `*FromSource`
methods in `worker-prepass-source.ts`; this adopts the ABI copy, and the Rust
Arc clones do not copy the source. Each worker has a separate linear memory;
the shared JS source does not share their WASM heaps. Shard scans can also
trap while installing or scanning that source.

## Serial allocation overlap

The scan builds an `FxHashMap<u32, (usize, usize)>`. On wasm32 a bucket payload
is 12 bytes plus one control byte; hashbrown reserves a power-of-two bucket
count at a 7/8 load factor. With the initial `E = min(F / 50, 40_000_000)`
reservation, approximately

`H(E) = 13 * next_power_of_two(ceil(8 * E / 7))`

bytes are reserved, plus small alignment/control-group overhead. This is not
the final compact index's `12N` footprint. The old metadata snapshot used
`HashMap::clone`, which copies the reservation even when almost empty. Unit
or RTC fallback can simultaneously build another full-file hash index.

For `F = 1,800,000,000`, `E = 36,000,000` and `H(E)` is about 872,415,232
bytes (832 MiB). Source + scan table + metadata clone + fallback table can
therefore reach **4,417,245,696 bytes (4.114 GiB)** before discovery lists,
decoded-entity caches, stack, allocator fragmentation and other overhead.
This is an illustrative overlap, not proof of the exact trap site. At
1,649,550,000 source bytes the same bucket rounding puts that subtotal at
about 3.974 GiB, leaving almost no room for the omitted allocations.

The compact snapshot now reserves for the **populated row count**. If metadata
triggers early with few indexed rows, the illustrative subtotal becomes
**3,544,830,464 bytes (3.301 GiB) plus the small snapshot**. If the first 50
jobs occur late, the snapshot can still be large. This is why fixing the
clone alone does not qualify a 1.8 GB source as safe.

Hash-table growth can overlap old and new tables. At final conversion,
`from_hashmap_consuming` overlaps the table with `12N` interleaved rows, frees
the table, sorts in place, then overlaps rows with the final `12N` columns.
The metadata snapshot changes no spans or duplicate-id precedence; final
sorted index bytes are covered by its regression test. Discovery, job order,
style resolution, and wire encodings are unchanged.

## Sharded and discovery allocations

The sharded binding already adopts the three ABI-owned index columns: `12N`
bytes, with a separate `N`-byte class slice alive until the call returns. It
does not allocate the serial staging hash table. Sorted unique ids take the
adoption fast path; unsorted/duplicate ids additionally overlap a `4N`
permutation and `12N` output columns, giving about **`F + 29N`** before
discovery/caches. At 36 million rows and a 1.8 GB source that is 2.844 GB;
denser input, many styled items, or decoded data can substantially increase it.
Shard scanners also grow record and class Vecs before exporting JS columns.

`PrepassSpans` and mapped spans store `(u32, usize, usize)`, 12 bytes per
capacity slot on wasm32. Sharded discovery currently even builds styled spans
before discarding them because external style shards do the resolution.
These Vecs grow geometrically: capacity can approach twice the live count;
a moving reallocation can briefly hold old plus new storage, approximately
three times the old capacity. Jobs and type candidates additionally carry an
`IfcType` (including its unknown-keyword payload); their cost is
`capacity * size_of::<(u32, usize, usize, IfcType)>()`, plus owned unknown text.
Their target-dependent layout must not be confused with the 12-byte wire job.

Despite its name, `buffered_jobs` retains **all** occurrence jobs until the
post-scan affinity pass. `chunk_size` (normally 50,000) bounds emission, not
the discovery allocation. Per emitted chunk of `K` jobs, JS receives `12K`
job bytes plus `4K` affinity bytes; the Rust affinity scratch is `4K` bytes.
Those do not add another source-sized WASM copy. Resolved styles/materials,
void maps, decoder caches and their flattening buffers remain model-dependent.
Freeing Rust allocations makes blocks reusable; linear memory itself does not
shrink, and fragmentation may prevent a large contiguous allocation.

## Admission and limits

No source-size admission ceiling is imposed: large files that load successfully
can continue to load. After an OOM-shaped trap on a source of at least 1 GB
(decimal), serial pre-pass, sharded pre-pass and shard scan report an actionable
"Out of memory:" error, including compatibility-retry failures. The viewer
classifies it as `out_of_memory`. A Rust panic produces the same `unreachable`
signature but stashes its source location first (#2527); a trap with a stashed
location is left unmapped. The raw trap stays in the message tail. `.cause` is
set only inside the worker: the worker posts the message alone, so callers on
the main thread see the text, not the cause.

This is a failure-reporting heuristic, not proof of OOM or a guarantee that a
1.8 GB file will load. Snapshot compaction reduces an avoidable allocation;
model density, metadata location and host memory still determine peak use.

## Content ownership (C4-11b)

`IfcAPI::content` separates source/pending-finish inputs from derived slots and
session settings. Derived slot declarations also generate their exhaustive reset
walk. Lazy builders publish under one slot lock; batch routers clone shared
handles. ProductionModel keeps its identity and expires its snapshots at the
same C4-11a install/cleanup boundaries. Source-byte installation retains the
worker's already injected entity index and columns. End-of-load diagnostics
remain readable after cleanup.

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
the shared JS source does not share their WASM heaps. `scan-shard` must be
guarded too, before it installs that source.

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
style resolution, and wire encodings are unchanged for admitted inputs.

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

The worker now refuses **`F >= 1,500,000,000` decimal bytes** before serial
pre-pass, sharded pre-pass, or shard scan enters WASM. This conservative policy
includes both production failures whether telemetry's MB means decimal or
binary units. The normal worker error contains **"Out of memory"**, the
source size, the 4 GiB constraint, and split-model/native CLI/server actions;
the viewer's existing `load-errors.ts` classifies it as `out_of_memory`.
It does not manufacture a WASM panic location or replay a failed allocation.
For a refused 1.8 GB file the incremental file/index WASM allocation changes
from the estimates above to **zero**; existing engine/JS allocations remain.

This ceiling does not guarantee success for every smaller file or every host.
It deliberately trades support for possibly loadable large files for a clear
failure in the observed crash band. Raising it needs real large-file browser
peak evidence, including late metadata, dense entities, styles, unsorted ids,
and geometry-worker memory. Snapshot compaction is not a claim that the whole
viewer can now load a 1.8 GB file.

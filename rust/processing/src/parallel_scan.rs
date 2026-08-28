// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Parallel entity-index construction.
//!
//! [`build_entity_index_parallel`] returns a **byte-identical**
//! [`EntityIndex`](ifc_lite_core::EntityIndex) to the serial
//! [`ifc_lite_core::build_entity_index`], but scans the STEP DATA section on all
//! cores. The STEP scan (entity offsets) is otherwise 100% single-threaded and
//! is a large fraction of load on big models.
//!
//! ## Why byte-identical is achievable despite splitting mid-record
//!
//! The serial builder walks `EntityScanner::next_entity()` from the header-skip
//! to EOF and does `index.insert(id, (start, end))` per entity, so the contract
//! we must reproduce is: **the same key set, the same spans, and last-wins on a
//! duplicate id in file order.**
//!
//! We split the file into N byte ranges and scan them concurrently. Only chunk 0
//! starts at a known-good boundary (`EntityScanner::new`, header-aware); every
//! other chunk starts at an arbitrary byte via `EntityScanner::new_at`, which may
//! land inside a quoted string or a `/* … */` comment. A speculative scan from
//! there can emit garbage "records" until it re-synchronises to the real STEP
//! record grid (STEP is self-synchronising: after the next real `;` terminator
//! the misaligned scanner produces exactly the records an aligned scanner would).
//!
//! The **handoff-stitch** makes this exact, not heuristic:
//!   * Each chunk `i` scans until the first entity whose `start >= range_end_i`,
//!     recording that offset as its `handoff` (the first real entity the *next*
//!     chunk owns), and keeps every earlier record.
//!   * A serial O(N) stitch replays the chunks in order. Chunk 0 is authoritative.
//!     For chunk `i>0` the previous chunk's validated handoff is a **real** entity
//!     start; we binary-search chunk `i`'s records for it. Records before it are
//!     speculative false-starts and are dropped; from it onward the scan is
//!     provably aligned (a record can only begin exactly at that offset if the
//!     `#`-hunt landed on the real `#`, and `find_entity_end` re-parses the record
//!     from its `#`, so the span is computed identically).
//!   * If the handoff is **not** present (the speculative scan overshot it, or a
//!     single record spans the whole chunk), we fall back to a serial rescan of
//!     that one range from the known-real handoff — identical output to the serial
//!     builder for those bytes. This never triggers on real files; it is the
//!     correctness net that keeps the merge byte-identical on adversarial input.
//!
//! Concatenating the validated slices in chunk order reproduces the serial
//! file-order entity stream with no gap and no overlap, so inserting them in that
//! order preserves last-wins exactly.
//!
//! ## Targets
//!
//! Native only. On wasm32 rayon runs inline (no worker threads are wired), so a
//! parallel driver buys nothing and only adds merge overhead — the wasm build
//! delegates straight to the serial scanner and is unchanged.

use ifc_lite_core::{EntityIndex, EntityScanner};

/// One shard's records: `(id, start, end)` per entity, strictly increasing in `start`.
pub type ShardRecords = Vec<(u32, usize, usize)>;

/// One shard's refusals: the `start` byte of each record the scan dropped for
/// an instance name above `u32::MAX` (#3395), strictly increasing.
///
/// Offsets, not a count, because a shard cannot tell on its own which of its
/// refusals are real — see [`scan_shard_with_refusals`].
pub type ShardRefusals = Vec<usize>;

/// [`scan_shard_with_refusals`] without the refusal offsets.
///
/// A shard's refusal list is only meaningful next to the stitch that decides
/// which of the shard's bytes were kept, so this convenience wrapper is for
/// callers that build no index from the result (the parity tests) — a caller
/// that DOES must take the offsets and attribute them, or it reports refusals
/// that no retained record produced.
pub fn scan_shard(
    content: &[u8],
    range_start: usize,
    range_end: usize,
) -> (ShardRecords, Option<usize>) {
    let (records, handoff, _refusals) = scan_shard_with_refusals(content, range_start, range_end);
    (records, handoff)
}

/// One shard's speculative scan over `[range_start, range_end)`, plus the byte
/// offset of every record this shard refused.
///
/// This is the exact per-chunk primitive [`build_entity_index_parallel`] fans
/// across cores, and the sibling of the wasm **sharded pre-pass**'s
/// `scan_shard_classified_with_refusals`: each browser geometry worker calls
/// that one on a byte range and the main thread stitches the columns
/// (binary-searching each shard for the previous shard's handoff — see the
/// [`native::stitch`] doc). Compiled on all targets (the `native` merge is
/// wasm-gated, but the shard primitive itself is target-independent).
///
/// Chunk 0 (`range_start == 0`) uses the header-aware [`EntityScanner::new`];
/// every other shard starts *speculatively* at `range_start` via
/// [`EntityScanner::new_at`] (which may land mid-record — the handoff stitch
/// makes that exact, not heuristic). Returns every record with
/// `start < range_end` (strictly increasing in `start`), the `handoff` (the
/// `start` of the first record at/after `range_end`, i.e. the next shard's
/// first real entity, or `None` at EOF), and the refusal offsets.
///
/// **It does not report them, and it must not.** A shard with
/// `range_start > 0` starts at an arbitrary byte, so it can begin inside a
/// quoted value; a string literal containing `#4294967297=IFCWALL(` satisfies
/// the scanner's `#<digits>[ws]*=` shape check (which has no quote context),
/// so the speculative prefix can refuse arbitrarily many records that the file
/// never declared. Reporting from inside the shard therefore turns a file with
/// NOTHING oversized in it into a "skipped N records" warning — a false alarm
/// on valid input, which is worse than the inflated count the first version of
/// this was thought to produce (#3395, retracted reasoning on #3430).
///
/// Bounding by ownership alone (`start < range_end`) does not fix it either:
/// a false refusal parsed out of a quoted value INSIDE the owned range still
/// counts. Only the stitch knows which bytes of a shard were kept, so only the
/// stitch can attribute a refusal — see [`native::stitch`].
pub fn scan_shard_with_refusals(
    content: &[u8],
    range_start: usize,
    range_end: usize,
) -> (ShardRecords, Option<usize>, ShardRefusals) {
    // Deliberately NOT delegating to `scan_shard_classified`: index-only
    // callers (native exporters / georeferencing via
    // `build_entity_index_parallel`) would pay a per-entity keyword
    // classification — string matches + the `has_geometry_by_name` cache —
    // across every record for a column they never read.
    let mut scanner = if range_start == 0 {
        EntityScanner::new(content)
    } else {
        EntityScanner::new_at(content, range_start)
    };
    let mut records = Vec::new();
    let mut handoff = None;
    while let Some((id, _type_name, start, entity_end)) = scanner.next_entity() {
        if start >= range_end {
            handoff = Some(start);
            break;
        }
        records.push((id, start, entity_end));
    }
    (records, handoff, scanner.skipped_oversized_id_starts().to_vec())
}

/// Build the entity index (expressId -> byte span) across all available cores.
///
/// Byte-identical to [`ifc_lite_core::build_entity_index`] over the same
/// `content`; a drop-in replacement wherever the index is built as a standalone
/// scan on native. On wasm32 it *is* the serial builder.
///
/// Safe to nest under an outer rayon task (it is a pure map-reduce with no locks
/// or channels); rayon work-steals rather than deadlocking. In practice every
/// caller invokes it at the top level, before the per-element geometry
/// `par_iter`, so no nesting occurs.
pub fn build_entity_index_parallel<T>(content: &T) -> EntityIndex
where
    T: AsRef<[u8]> + ?Sized,
{
    let content = content.as_ref();
    #[cfg(target_arch = "wasm32")]
    {
        ifc_lite_core::build_entity_index(content)
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        native::build(content)
    }
}

#[cfg(not(target_arch = "wasm32"))]
mod native {
    use ifc_lite_core::{build_entity_index, EntityIndex, EntityScanner};
    use rayon::prelude::*;
    use rustc_hash::FxHashMap;

    /// Below this DATA-section size the fork/join + serial-merge overhead
    /// outweighs the scan win, so we run the serial scanner unchanged.
    const PARALLEL_MIN_BYTES: usize = 8 * 1024 * 1024;

    /// Target minimum bytes per chunk. Chunks are byte ranges, and scan cost is
    /// ~proportional to bytes, so equal byte splits balance the work; this floor
    /// keeps the chunk count sane on merely-large (not huge) files.
    const MIN_CHUNK_BYTES: usize = 2 * 1024 * 1024;

    /// The one place the parallel path reports a refusal: once per load, on
    /// the stitched count, never per shard (#3395/#3430).
    pub(super) fn build(content: &[u8]) -> EntityIndex {
        let n = chunk_count(content.len());
        if n <= 1 {
            // Serial. Not merely a shortcut: the chunked path materialises a
            // `Vec<(u32, usize, usize)>` per chunk before the stitch inserts
            // it, ~20 B per entity, which is the price of splitting and is not
            // worth paying when there is nothing to split. `build_entity_index`
            // scans once straight into the map and reports its own refusals.
            return build_entity_index(content);
        }
        let (index, refused) = with_chunks_counted(content, n);
        ifc_lite_core::report_oversized_ids(refused);
        index
    }

    fn chunk_count(len: usize) -> usize {
        if len < PARALLEL_MIN_BYTES {
            return 1;
        }
        let threads = rayon::current_num_threads().max(1);
        let by_size = (len / MIN_CHUNK_BYTES).max(1);
        threads.min(by_size)
    }

    /// One chunk's speculative scan: every record with `start < range_end`, plus
    /// the `start` of the first record at/after `range_end` (the next chunk's
    /// first real entity). `records` is strictly increasing in `start`.
    struct ChunkScan {
        records: Vec<(u32, usize, usize)>,
        handoff: Option<usize>,
        /// Every refusal this chunk's scan produced, real or speculative. The
        /// stitch decides which; the chunk cannot.
        refusals: super::ShardRefusals,
    }

    #[inline]
    pub(super) fn range_end(i: usize, n_chunks: usize, len: usize) -> usize {
        if i + 1 == n_chunks {
            len
        } else {
            (i + 1) * len / n_chunks
        }
    }

    fn scan_chunk(content: &[u8], i: usize, n_chunks: usize) -> ChunkScan {
        let start = i * content.len() / n_chunks;
        let end = range_end(i, n_chunks, content.len());
        // Chunk 0 uses `new` for the exact header-skip / quoted-`DATA;`
        // semantics (`scan_shard` selects it on `range_start == 0`); every other
        // chunk starts speculatively at its byte offset. Same shard primitive the
        // wasm sharded pre-pass calls per worker, so the merge cannot drift.
        let (records, handoff, refusals) = super::scan_shard_with_refusals(content, start, end);
        ChunkScan {
            records,
            handoff,
            refusals,
        }
    }

    /// Scan with an explicit chunk count, returning the index and the number of
    /// refusals the stitch ATTRIBUTED — the count a caller may report, never
    /// the raw per-shard sum (see [`stitch`]). Public within the crate so the
    /// byte-identity and refusal-parity tests can force many boundary
    /// positions (including inside a quoted string) on a small buffer.
    ///
    /// `n_chunks == 1` is not special-cased HERE (though [`build`] takes a
    /// serial shortcut before reaching this): one chunk spans the whole file,
    /// starts at 0 (so the header-aware [`EntityScanner::new`] is selected)
    /// and has no boundary, which is precisely the serial scan. Routing it
    /// through the same shard+stitch machinery means the `n = 1` leg of the
    /// byte-identity sweep exercises this code rather than delegating past it.
    pub(super) fn with_chunks_counted(content: &[u8], n_chunks: usize) -> (EntityIndex, usize) {
        let len = content.len();
        let n_chunks = n_chunks.max(1).min(len.max(1));
        let chunks: Vec<ChunkScan> = (0..n_chunks)
            .into_par_iter()
            .map(|i| scan_chunk(content, i, n_chunks))
            .collect();
        stitch(content, &chunks, n_chunks)
    }

    /// Replay the chunks in file order into one index, and count the refusals
    /// that are attributable to the bytes actually retained.
    ///
    /// ## Why a refusal needs attributing at all
    ///
    /// A refusal is a record the scanner dropped, so it leaves no trace in
    /// `records` and the stitch cannot re-derive it. A chunk `i > 0` starts at
    /// an arbitrary byte and can begin inside a quoted value, where a string
    /// literal shaped like `#4294967297=IFCWALL(` reads as a record and gets
    /// refused. Those refusals belong to the speculative prefix this stitch
    /// throws away, so summing the chunks would report refusals on a file that
    /// declares none.
    ///
    /// ## The rule, and why it is exact
    ///
    /// Chunk `i`'s retained region begins at `target` — chunk `i-1`'s
    /// validated handoff, a REAL entity start — and chunk 0's begins at the
    /// header skip. Scanner events advance `position` monotonically, so every
    /// event a chunk emitted before the record at `target` sits strictly below
    /// `target`; and from that record on, the chunk's `position` sequence is
    /// the serial scanner's (the handoff is a real start and `find_entity_end`
    /// re-parses the record from its `#`). Hence:
    ///
    ///   * refusals `>= target` are exactly the post-resynchronisation ones,
    ///     and they are the ones a serial scan over those bytes also produces;
    ///   * refusals `< target` are exactly the speculative-prefix ones, and
    ///     they are dropped with the records they sat among.
    ///
    /// A chunk stops at the first record at/after its `range_end`, which is
    /// the next chunk's `target`, so the intervals `[target_i, target_{i+1})`
    /// tile the file with no gap and no overlap: each real refusal is counted
    /// once, by exactly one chunk. On the `Err` fallback the chunk is
    /// discarded whole, refusals included, and the serial rescan over the same
    /// bytes supplies them instead.
    ///
    /// What this does NOT bound: a `#<digits>=` inside a quoted value that the
    /// SERIAL scanner also mis-parses (only reachable on malformed input,
    /// where a stray quote has already flipped `find_entity_end`'s parity)
    /// still counts here, because it counts there. That is parity with the
    /// serial path, which is the target — not immunity to mis-parsing, which
    /// would mean giving the scanner quote context (#3395/#3430).
    fn stitch(content: &[u8], chunks: &[ChunkScan], n_chunks: usize) -> (EntityIndex, usize) {
        let len = content.len();
        // Same capacity heuristic as the serial builder.
        let mut index: EntityIndex =
            FxHashMap::with_capacity_and_hasher(len / 50, Default::default());

        // Chunk 0 is authoritative: it started at the real header-skip boundary.
        for &(id, start, end) in &chunks[0].records {
            index.insert(id, (start, end));
        }
        let mut expected_start = chunks[0].handoff;
        let mut refused = chunks[0].refusals.len();

        for (i, chunk) in chunks.iter().enumerate().skip(1) {
            // `expected_start` is the real entity start where chunk `i` begins,
            // validated by chunk `i-1`. `None` => no more real entities, so
            // every later chunk is speculative from end to end — records and
            // refusals alike are dropped by breaking here.
            let target = match expected_start {
                Some(t) => t,
                None => break,
            };
            let end = range_end(i, n_chunks, len);
            let recs = &chunk.records;
            // `records` is strictly increasing in `start`, so a binary search
            // locates the real boundary (or proves the chunk never re-synced).
            match recs.binary_search_by(|&(_, start, _)| start.cmp(&target)) {
                Ok(p) => {
                    for &(id, start, e) in &recs[p..] {
                        index.insert(id, (start, e));
                    }
                    // `refusals` is strictly increasing, so the split point is
                    // the first refusal inside the retained region.
                    let from = chunk.refusals.partition_point(|&o| o < target);
                    refused += chunk.refusals.len() - from;
                    expected_start = chunk.handoff;
                }
                Err(_) => {
                    // Rare: the speculative scan overshot the real boundary, or a
                    // single record spans the whole chunk. Serially rescan this
                    // range from the known-real `target` — byte-identical to the
                    // serial builder for these bytes — and recompute the handoff.
                    // The chunk's own refusals go with its records: unusable.
                    let (next, rescanned) = rescan_range(content, target, end, &mut index);
                    refused += rescanned;
                    expected_start = next;
                }
            }
        }
        (index, refused)
    }

    /// Serial rescan from a known-real entity start `target` up to `end`,
    /// inserting each entity; returns the first entity start at/after `end`
    /// (the handoff for the next chunk, or `None` at EOF) together with the
    /// refusals over those bytes.
    ///
    /// This scan is aligned from its first byte, so every refusal it makes is
    /// one the serial builder makes too — no attribution needed.
    fn rescan_range(
        content: &[u8],
        target: usize,
        end: usize,
        index: &mut EntityIndex,
    ) -> (Option<usize>, usize) {
        let mut scanner = EntityScanner::new_at(content, target);
        while let Some((id, _type_name, start, entity_end)) = scanner.next_entity() {
            if start >= end {
                return (Some(start), scanner.skipped_oversized_ids());
            }
            index.insert(id, (start, entity_end));
        }
        (None, scanner.skipped_oversized_ids())
    }
}

#[cfg(all(test, not(target_arch = "wasm32")))]
#[path = "parallel_scan_tests.rs"]
mod tests;

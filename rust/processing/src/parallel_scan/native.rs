// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! The native fork/join scan + handoff-stitch merge behind
//! [`super::build_entity_index_parallel`]. Split out of `parallel_scan.rs`
//! per the repo's module-size convention (see `decoder.rs` /
//! `decoder/caches.rs`) — this is the bulk of that module's logic, not test
//! code, but the same "split rather than exceed the ratchet" rule applies.

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
/// the stitched count, never per shard (#3395/#3430). Same rule for the
/// #3695 malformed-record stop, on the stitched flag `stitch` attributes.
pub(super) fn build(content: &[u8]) -> EntityIndex {
    let n = chunk_count(content.len());
    if n <= 1 {
        // Serial. Not merely a shortcut: the chunked path materialises a
        // `Vec<(u32, usize, usize)>` per chunk before the stitch inserts
        // it, ~20 B per entity, which is the price of splitting and is not
        // worth paying when there is nothing to split. `build_entity_index`
        // scans once straight into the map and reports its own refusals
        // (oversized ids AND, since it shares `EntityScanner`, a
        // malformed-record stop).
        return build_entity_index(content);
    }
    let stitched = with_chunks_counted(content, n);
    ifc_lite_core::report_oversized_ids(stitched.refused);
    ifc_lite_core::report_malformed_records(stitched.malformed);
    stitched.index
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
    /// Where this chunk's scan stopped on a malformed record, real or
    /// speculative — same caveat as `refusals`.
    malformed_start: Option<usize>,
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
    let (records, handoff, refusals, malformed_start) =
        super::scan_shard_with_diagnostics(content, start, end);
    ChunkScan {
        records,
        handoff,
        refusals,
        malformed_start,
    }
}

/// [`stitch`]'s result: the merged index, the number of refusals it
/// ATTRIBUTED (never the raw per-shard sum — see [`stitch`]'s doc), and
/// whether it attributed a real #3695 malformed-record stop.
///
/// Named rather than a positional tuple so a caller reads `stitched.refused`
/// and `stitched.malformed` rather than `.1` / `.2` — the two fields are
/// different types here (`usize` / `bool`), but [`RescanResult`] right below
/// has two `Option<usize>` fields in the same shape a tuple would let a
/// caller swap silently, and consistency between the two return types
/// (both feed the same stitch loop) keeps that discipline from looking
/// like a special case.
pub(super) struct StitchResult {
    pub(super) index: EntityIndex,
    pub(super) refused: usize,
    pub(super) malformed: bool,
}

/// Scan with an explicit chunk count. Public within the crate so the
/// byte-identity and refusal-parity tests can force many boundary
/// positions (including inside a quoted string) on a small buffer.
///
/// `n_chunks == 1` is not special-cased HERE (though [`build`] takes a
/// serial shortcut before reaching this): one chunk spans the whole file,
/// starts at 0 (so the header-aware [`EntityScanner::new`] is selected)
/// and has no boundary, which is precisely the serial scan. Routing it
/// through the same shard+stitch machinery means the `n = 1` leg of the
/// byte-identity sweep exercises this code rather than delegating past it.
pub(super) fn with_chunks_counted(content: &[u8], n_chunks: usize) -> StitchResult {
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
///
/// ## The malformed-record stop (#3695) is not "one more refusal count"
///
/// An oversized-id refusal SKIPS one record and scanning continues. A
/// malformed record (unterminated `'` string / `/* … */` comment) has no
/// byte to resume from, so the SERIAL scanner stops PERMANENTLY — nothing
/// past that byte is ever in the serial index. Byte-identity means the
/// parallel path must match: the first chunk (file order) whose
/// ATTRIBUTED region contains a malformed stop drops every chunk after
/// it, the same way `expected_start: None` already does when a chunk runs
/// out of real entities. The returned bool is `true` in exactly that
/// case; callers report it once, stitched, never per shard.
///
/// "Attributed" carries the same speculative-prefix caveat as a refusal —
/// `chunk.malformed_start >= target` is that filter, mirroring the `<
/// target` split `refusals.partition_point` already makes.
fn stitch(content: &[u8], chunks: &[ChunkScan], n_chunks: usize) -> StitchResult {
    let len = content.len();
    // Same capacity heuristic as the serial builder.
    let mut index: EntityIndex =
        FxHashMap::with_capacity_and_hasher(len / 50, Default::default());

    // Chunk 0 is authoritative: it started at the real header-skip
    // boundary, so it has no speculative prefix to filter a malformed
    // stop against — any it hit is real, unconditionally.
    for &(id, start, end) in &chunks[0].records {
        index.insert(id, (start, end));
    }
    let mut expected_start = chunks[0].handoff;
    let mut refused = chunks[0].refusals.len();
    let mut malformed = chunks[0].malformed_start.is_some();

    if !malformed {
        for (i, chunk) in chunks.iter().enumerate().skip(1) {
            // `expected_start` is the real entity start where chunk `i`
            // begins, validated by chunk `i-1`. `None` => no more real
            // entities, so every later chunk is speculative from end to
            // end — records and refusals alike are dropped by breaking
            // here.
            let target = match expected_start {
                Some(t) => t,
                None => break,
            };
            let end = range_end(i, n_chunks, len);
            let recs = &chunk.records;
            // `records` is strictly increasing in `start`, so a binary
            // search locates the real boundary (or proves the chunk
            // never re-synced).
            match recs.binary_search_by(|&(_, start, _)| start.cmp(&target)) {
                Ok(p) => {
                    for &(id, start, e) in &recs[p..] {
                        index.insert(id, (start, e));
                    }
                    // `refusals` is strictly increasing, so the split
                    // point is the first refusal inside the retained
                    // region.
                    let from = chunk.refusals.partition_point(|&o| o < target);
                    refused += chunk.refusals.len() - from;
                    // A malformed stop at/after `target` sits inside the
                    // region this chunk just proved it resynchronised
                    // over, so it is real — the same filter the refusal
                    // count above just applied. Before `target` it is an
                    // artefact of the discarded speculative prefix.
                    if chunk.malformed_start.is_some_and(|m| m >= target) {
                        malformed = true;
                        break;
                    }
                    expected_start = chunk.handoff;
                }
                Err(_) => {
                    // Rare: the speculative scan overshot the real boundary, or a
                    // single record spans the whole chunk. Serially rescan this
                    // range from the known-real `target` — byte-identical to the
                    // serial builder for these bytes — and recompute the handoff.
                    // The chunk's own refusals go with its records: unusable.
                    //
                    // This rescan starts at a validated real boundary, not
                    // speculatively, so ANY malformed stop it hits is real —
                    // no `>= target` filter needed, unlike the `Ok` arm.
                    let rescanned = rescan_range(content, target, end, &mut index);
                    refused += rescanned.refused;
                    if rescanned.malformed_start.is_some() {
                        malformed = true;
                        break;
                    }
                    expected_start = rescanned.handoff;
                }
            }
        }
    }
    StitchResult { index, refused, malformed }
}

/// [`rescan_range`]'s result: the handoff for the next chunk (the first
/// entity start at/after `end`, or `None` at EOF), the refusals rescanned
/// over `[target, end)`, and the malformed-record stop over those bytes if
/// any.
///
/// Named, not a positional tuple, because `handoff` and `malformed_start`
/// are BOTH `Option<usize>` — a tuple would let a caller swap them (e.g.
/// treat the handoff as the malformed stop) with no type error to catch it.
struct RescanResult {
    handoff: Option<usize>,
    refused: usize,
    malformed_start: Option<usize>,
}

/// Serial rescan from a known-real entity start `target` up to `end`,
/// inserting each entity.
///
/// This scan is aligned from its first byte, so every refusal — and
/// every malformed stop — it makes is one the serial builder makes too:
/// no attribution needed, unlike [`stitch`]'s `Ok` arm.
fn rescan_range(
    content: &[u8],
    target: usize,
    end: usize,
    index: &mut EntityIndex,
) -> RescanResult {
    let mut scanner = EntityScanner::new_at(content, target);
    while let Some((id, _type_name, start, entity_end)) = scanner.next_entity() {
        if start >= end {
            return RescanResult {
                handoff: Some(start),
                refused: scanner.skipped_oversized_ids(),
                malformed_start: scanner.malformed_record_start(),
            };
        }
        index.insert(id, (start, entity_end));
    }
    RescanResult {
        handoff: None,
        refused: scanner.skipped_oversized_ids(),
        malformed_start: scanner.malformed_record_start(),
    }
}

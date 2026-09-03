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
/// refusals are real — see [`scan_shard_with_diagnostics`], which is where
/// that "cannot report from inside a shard" reasoning actually lives.
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

/// [`scan_shard_with_diagnostics`] without the malformed-record offset.
///
/// Kept as its own 3-tuple-returning function — not folded into
/// [`scan_shard_with_diagnostics`] in place — because it is public on a
/// published crate and adding a return value in place would be a breaking
/// change (the same reasoning [`crate::scan_shard_classified`] documents for
/// staying a 3-tuple after #3395 added refusal offsets).
pub fn scan_shard_with_refusals(
    content: &[u8],
    range_start: usize,
    range_end: usize,
) -> (ShardRecords, Option<usize>, ShardRefusals) {
    let (records, handoff, refusals, _malformed_start) =
        scan_shard_with_diagnostics(content, range_start, range_end);
    (records, handoff, refusals)
}

/// One shard's speculative scan over `[range_start, range_end)`, plus the byte
/// offset of every record this shard refused and, if any, the byte offset of
/// the record that made the scan stop early (#3695's malformed-record stop).
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
/// first real entity, or `None` at EOF), the refusal offsets, and the
/// malformed-record stop offset (see below).
///
/// **It does not report either diagnostic, and it must not.** A shard with
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
///
/// The malformed-record stop offset is the byte offset of the record — if
/// any — that made [`ifc_lite_core::EntityScanner::find_entity_end`] fail
/// (an unterminated `'` string or `/* … */` comment). Unlike an oversized-id
/// refusal, the scanner STOPS ENTIRELY when this happens, so `records`/
/// `handoff` above already reflect it; this offset is only the "why", for
/// [`native::stitch`] to attribute — same speculative-prefix caveat as a
/// refusal, so it is not reported here either.
pub fn scan_shard_with_diagnostics(
    content: &[u8],
    range_start: usize,
    range_end: usize,
) -> (ShardRecords, Option<usize>, ShardRefusals, Option<usize>) {
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
    (
        records,
        handoff,
        scanner.skipped_oversized_id_starts().to_vec(),
        scanner.malformed_record_start(),
    )
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

// Split into its own file (module-size ratchet: this is the bulk of the
// merge logic, not test code) — see `native.rs`'s own doc comment.
#[cfg(not(target_arch = "wasm32"))]
#[path = "parallel_scan/native.rs"]
mod native;

#[cfg(all(test, not(target_arch = "wasm32")))]
#[path = "parallel_scan_tests.rs"]
mod tests;

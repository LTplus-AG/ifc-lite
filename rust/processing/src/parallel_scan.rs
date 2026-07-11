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

/// One shard's speculative scan over `[range_start, range_end)`.
///
/// This is the exact per-chunk primitive [`build_entity_index_parallel`] fans
/// across cores, exposed for the wasm **sharded pre-pass**: each browser
/// geometry worker calls it on a byte range and the main thread stitches the
/// columns (binary-searching each shard for the previous shard's handoff — see
/// the [`native::stitch`] doc). Compiled on all targets (the `native` merge is
/// wasm-gated, but the shard primitive itself is target-independent).
///
/// Chunk 0 (`range_start == 0`) uses the header-aware [`EntityScanner::new`];
/// every other shard starts *speculatively* at `range_start` via
/// [`EntityScanner::new_at`] (which may land mid-record — the handoff stitch
/// makes that exact, not heuristic). Returns every record with
/// `start < range_end` (strictly increasing in `start`) plus the `handoff`: the
/// `start` of the first record at/after `range_end` (the next shard's first real
/// entity), or `None` at EOF.
pub fn scan_shard(
    content: &[u8],
    range_start: usize,
    range_end: usize,
) -> (Vec<(u32, usize, usize)>, Option<usize>) {
    let (records, _classes, handoff) = scan_shard_classified(content, range_start, range_end);
    (records, handoff)
}

/// Per-record prepass class emitted by [`scan_shard_classified`].
///
/// Only the codes a downstream consumer needs are defined; everything else is
/// [`PREPASS_CLASS_NONE`]. Classification happens AT SCAN TIME from the same
/// `type_name` string the serial pre-pass matches on, so a consumer that
/// filters records by class reproduces the serial pre-pass's span collection
/// byte-for-byte (same keyword compare, same file order).
pub const PREPASS_CLASS_NONE: u8 = 0;
/// `IFCSTYLEDITEM` — the styled-item spans the pre-pass resolver classifies
/// into orphan (material appearance) vs geometry-attached styles.
pub const PREPASS_CLASS_STYLED_ITEM: u8 = 4;
/// `IFCINDEXEDCOLOURMAP` (#663/#858).
pub const PREPASS_CLASS_INDEXED_COLOUR_MAP: u8 = 5;
/// `IFCMATERIALDEFINITIONREPRESENTATION` (#407).
pub const PREPASS_CLASS_MATERIAL_DEF_REPR: u8 = 6;
/// `IFCRELASSOCIATESMATERIAL` (#407).
pub const PREPASS_CLASS_REL_ASSOCIATES_MATERIAL: u8 = 7;
/// `IFCRELVOIDSELEMENT`.
pub const PREPASS_CLASS_REL_VOIDS: u8 = 8;
/// `IFCRELFILLSELEMENT`.
pub const PREPASS_CLASS_REL_FILLS: u8 = 9;
/// `IFCRELAGGREGATES`.
pub const PREPASS_CLASS_REL_AGGREGATES: u8 = 10;

/// [`scan_shard`] plus a parallel per-record class column (see the
/// `PREPASS_CLASS_*` codes). Same records, same handoff; the class byte lets
/// the browser host extract pre-pass span lists (today: styled items) from the
/// stitched shard columns WITHOUT waiting for the serial pre-pass scan.
pub fn scan_shard_classified(
    content: &[u8],
    range_start: usize,
    range_end: usize,
) -> (Vec<(u32, usize, usize)>, Vec<u8>, Option<usize>) {
    let mut scanner = if range_start == 0 {
        EntityScanner::new(content)
    } else {
        EntityScanner::new_at(content, range_start)
    };
    let mut records = Vec::new();
    let mut classes = Vec::new();
    let mut handoff = None;
    while let Some((id, type_name, start, entity_end)) = scanner.next_entity() {
        if start >= range_end {
            handoff = Some(start);
            break;
        }
        records.push((id, start, entity_end));
        classes.push(match type_name {
            "IFCSTYLEDITEM" => PREPASS_CLASS_STYLED_ITEM,
            "IFCINDEXEDCOLOURMAP" => PREPASS_CLASS_INDEXED_COLOUR_MAP,
            "IFCMATERIALDEFINITIONREPRESENTATION" => PREPASS_CLASS_MATERIAL_DEF_REPR,
            "IFCRELASSOCIATESMATERIAL" => PREPASS_CLASS_REL_ASSOCIATES_MATERIAL,
            "IFCRELVOIDSELEMENT" => PREPASS_CLASS_REL_VOIDS,
            "IFCRELFILLSELEMENT" => PREPASS_CLASS_REL_FILLS,
            "IFCRELAGGREGATES" => PREPASS_CLASS_REL_AGGREGATES,
            _ => PREPASS_CLASS_NONE,
        });
    }
    (records, classes, handoff)
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

    pub(super) fn build(content: &[u8]) -> EntityIndex {
        let n = chunk_count(content.len());
        if n <= 1 {
            return build_entity_index(content);
        }
        with_chunks(content, n)
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
    }

    #[inline]
    fn range_end(i: usize, n_chunks: usize, len: usize) -> usize {
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
        let (records, handoff) = super::scan_shard(content, start, end);
        ChunkScan { records, handoff }
    }

    /// Scan with an explicit chunk count. Public within the crate so the
    /// byte-identity tests can force many boundary positions (including inside a
    /// quoted string) on a small buffer.
    pub(super) fn with_chunks(content: &[u8], n_chunks: usize) -> EntityIndex {
        let len = content.len();
        let n_chunks = n_chunks.max(1).min(len.max(1));
        if n_chunks == 1 {
            return build_entity_index(content);
        }
        let chunks: Vec<ChunkScan> = (0..n_chunks)
            .into_par_iter()
            .map(|i| scan_chunk(content, i, n_chunks))
            .collect();
        stitch(content, &chunks, n_chunks)
    }

    fn stitch(content: &[u8], chunks: &[ChunkScan], n_chunks: usize) -> EntityIndex {
        let len = content.len();
        // Same capacity heuristic as the serial builder.
        let mut index: EntityIndex =
            FxHashMap::with_capacity_and_hasher(len / 50, Default::default());

        // Chunk 0 is authoritative: it started at the real header-skip boundary.
        for &(id, start, end) in &chunks[0].records {
            index.insert(id, (start, end));
        }
        let mut expected_start = chunks[0].handoff;

        for i in 1..n_chunks {
            // `expected_start` is the real entity start where chunk `i` begins,
            // validated by chunk `i-1`. `None` => no more real entities.
            let target = match expected_start {
                Some(t) => t,
                None => break,
            };
            let end = range_end(i, n_chunks, len);
            let recs = &chunks[i].records;
            // `records` is strictly increasing in `start`, so a binary search
            // locates the real boundary (or proves the chunk never re-synced).
            match recs.binary_search_by(|&(_, start, _)| start.cmp(&target)) {
                Ok(p) => {
                    for &(id, start, e) in &recs[p..] {
                        index.insert(id, (start, e));
                    }
                    expected_start = chunks[i].handoff;
                }
                Err(_) => {
                    // Rare: the speculative scan overshot the real boundary, or a
                    // single record spans the whole chunk. Serially rescan this
                    // range from the known-real `target` — byte-identical to the
                    // serial builder for these bytes — and recompute the handoff.
                    expected_start = rescan_range(content, target, end, &mut index);
                }
            }
        }
        index
    }

    /// Serial rescan from a known-real entity start `target` up to `end`,
    /// inserting each entity; returns the first entity start at/after `end` (the
    /// handoff for the next chunk), or `None` at EOF.
    fn rescan_range(
        content: &[u8],
        target: usize,
        end: usize,
        index: &mut EntityIndex,
    ) -> Option<usize> {
        let mut scanner = EntityScanner::new_at(content, target);
        while let Some((id, _type_name, start, entity_end)) = scanner.next_entity() {
            if start >= end {
                return Some(start);
            }
            index.insert(id, (start, entity_end));
        }
        None
    }

    #[cfg(test)]
    mod tests {
        use super::with_chunks;
        use ifc_lite_core::build_entity_index;

        /// Assert `with_chunks(content, n)` equals the serial index for a range of
        /// chunk counts — many `n` means many boundary positions, so a boundary
        /// lands inside strings/comments/records across the sweep.
        fn assert_parallel_matches_serial(content: &[u8], label: &str) {
            let serial = build_entity_index(content);
            for n in [1usize, 2, 3, 4, 5, 7, 8, 11, 16, 32, 64] {
                let par = with_chunks(content, n);
                assert_eq!(
                    par, serial,
                    "parallel index (n_chunks={n}) != serial for {label}"
                );
            }
        }

        #[test]
        fn empty_and_tiny_and_malformed() {
            assert_parallel_matches_serial(b"", "empty");
            assert_parallel_matches_serial(b"\n", "single-newline");
            assert_parallel_matches_serial(
                b"ISO-10303-21;\nHEADER;\nENDSEC;\nDATA;\nENDSEC;\n",
                "header-only",
            );
            assert_parallel_matches_serial(
                b"#1=IFCWALL('g',$,$,$,$,$,$,$);\n",
                "no-header",
            );
            // Truncated / malformed: unterminated record, stray '#', bad digits.
            assert_parallel_matches_serial(
                b"DATA;\n#1=IFCWALL('g',$,$\n#2=IFCDOOR( #notanid #=x ; ;",
                "malformed",
            );
        }

        #[test]
        fn simple_data_section() {
            let mut content = String::from("ISO-10303-21;\nHEADER;\nENDSEC;\nDATA;\n");
            for id in 1..=200u32 {
                content.push_str(&format!(
                    "#{id}=IFCCARTESIANPOINT(({}.,{}.,{}.));\n",
                    id, id, id
                ));
            }
            content.push_str("ENDSEC;\nEND-ISO-10303-21;\n");
            assert_parallel_matches_serial(content.as_bytes(), "simple-200");
        }

        /// Duplicate ids must resolve last-wins in file order, exactly as the
        /// serial `insert` loop does.
        #[test]
        fn duplicate_ids_last_wins() {
            let mut content = String::from("DATA;\n");
            for _ in 0..3 {
                for id in 1..=50u32 {
                    content.push_str(&format!("#{id}=IFCWALL('g{id}',$,$,$,$,$,$,$);\n"));
                }
            }
            assert_parallel_matches_serial(content.as_bytes(), "duplicate-ids");
        }

        /// Adversarial: a record whose quoted string contains fake `;` terminators
        /// and fake `#N=IFCWALL(...)` records. A chunk boundary inside the string
        /// makes the speculative scanner emit garbage until it re-syncs; the stitch
        /// (incl. the fallback) must still reproduce the serial index exactly.
        #[test]
        fn chunk_boundary_inside_quoted_string() {
            let mut fake = String::new();
            for k in 0..400 {
                fake.push_str(&format!(";\\n#{}=IFCWALL(fake ; still in string ", 90000 + k));
            }
            let mut content = String::from("ISO-10303-21;\nHEADER;\nENDSEC;\nDATA;\n");
            content.push_str("#1=IFCPROJECT('guid',$,$,$,$,$,$,$,$);\n");
            content.push_str(&format!("#2=IFCWALL('{fake}',$,$,$,$,$,$,$);\n"));
            for id in 3..=120u32 {
                content.push_str(&format!("#{id}=IFCDOOR('g{id}',$,$,$,$,$,$,$);\n"));
            }
            content.push_str("ENDSEC;\n");
            assert_parallel_matches_serial(content.as_bytes(), "in-string-boundary");
        }

        /// One record larger than a chunk (forces the "record spans chunk" /
        /// fallback path where the handoff sits beyond a chunk's whole range).
        #[test]
        fn record_larger_than_chunk() {
            let big_name = "X".repeat(20_000);
            let mut content = String::from("DATA;\n");
            content.push_str("#1=IFCPROJECT('g',$,$,$,$,$,$,$,$);\n");
            content.push_str(&format!("#2=IFCWALL('{big_name}',$,$,$,$,$,$,$);\n"));
            for id in 3..=40u32 {
                content.push_str(&format!("#{id}=IFCDOOR('g{id}',$,$,$,$,$,$,$);\n"));
            }
            assert_parallel_matches_serial(content.as_bytes(), "record-larger-than-chunk");
        }

        /// Fixture leg: byte-identical over real models when present. Sweeps chunk
        /// counts AND checks the public `build_entity_index_parallel` (thread-count
        /// driven) path. Skips (never fails) when fixtures are absent.
        #[test]
        fn fixtures_byte_identical() {
            for rel in [
                "ara3d/schependomlaan.ifc",
                "ara3d/AC-20-Smiley-West-10-Bldg.ifc",
                "various/01_BIMcollab_Example_ARC.ifc",
            ] {
                let path = format!("{}/../../tests/models/{}", env!("CARGO_MANIFEST_DIR"), rel);
                let Ok(content) = std::fs::read(&path) else {
                    eprintln!("skipping {rel}: fixture absent — run `pnpm fixtures`");
                    continue;
                };
                assert_parallel_matches_serial(&content, rel);
                assert_eq!(
                    super::super::build_entity_index_parallel(&content),
                    build_entity_index(&content),
                    "public build_entity_index_parallel != serial for {rel}"
                );
            }
        }
    }
}

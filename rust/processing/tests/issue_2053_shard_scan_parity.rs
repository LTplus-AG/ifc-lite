// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Parity regression for #2053: `scan_shard` (native
//! `build_entity_index_parallel`'s per-chunk primitive) and
//! `scan_shard_classified` (the wasm sharded pre-pass's per-worker primitive,
//! `rust/wasm-bindings/src/api/gpu_meshes/prepass_sharded.rs`'s
//! `scanEntityIndexShard`) are two independently-maintained loops over
//! `EntityScanner` — `scan_shard_classified` deliberately does NOT delegate to
//! `scan_shard` (see `parallel_scan.rs`'s doc comment on `scan_shard`), so
//! nothing stops them drifting apart if one is edited without the other.
//!
//! This test makes the "cannot drift" property in `prepass_sharded.rs`'s doc
//! comment a maintained invariant instead of prose: it asserts the two
//! functions produce IDENTICAL records (id, start, end) and handoff for the
//! same input over the same byte range, and additionally that
//! `scan_shard_classified`'s extra `classes` column — the output that has no
//! counterpart in `scan_shard`, and which the browser host indexes
//! POSITIONALLY against the records — stays aligned with those records: same
//! length, and each byte the class of the record at that index. Both are
//! checked over a whole-file single shard and over a shard boundary landing
//! mid-entity (the handoff/stitch case, where the two loops are most likely to
//! diverge since it exercises the `range_end` cutoff and speculative-scan
//! restart logic in each independently).
//!
//! `ifc-lite-processing` (this crate) is covered by the required CI lane
//! (`cargo test --workspace --exclude ifc-lite-wasm`); `ifc-lite-wasm`, which
//! actually calls `scan_shard_classified` in production, is excluded from it
//! entirely (#2049) — this test lives here, not in `rust/wasm-bindings/`,
//! specifically so a parity regression fails CI instead of only ever being
//! caught locally.

use ifc_lite_processing::{classify_type_name, scan_shard, scan_shard_classified};

/// Parse the raw STEP keyword at a record start (`#id=KEYWORD(...`). Mirrors
/// `issue_1910_shard_class_ci_coverage.rs`'s copy of the same helper —
/// duplicated rather than shared because integration tests are separate
/// crates and the original (`prepass_discovery.rs::keyword_at`) is private to
/// the excluded wasm crate.
fn keyword_at(content: &[u8], start: usize, end: usize) -> &str {
    let span = &content[start..end.min(content.len())];
    let eq = span.iter().position(|&b| b == b'=').map(|p| p + 1).unwrap_or(0);
    let kw_end = span[eq..]
        .iter()
        .position(|&b| b == b'(')
        .map(|p| eq + p)
        .unwrap_or(span.len());
    std::str::from_utf8(&span[eq..kw_end]).unwrap_or("").trim()
}

/// A small synthetic DATA section with enough entities, and varied enough
/// record lengths, that a boundary swept across the whole byte range lands
/// inside a record body at some sweep position — not just on a `\n`.
fn synthetic_ifc() -> String {
    let mut content = String::from(
        "ISO-10303-21;\nHEADER;\nENDSEC;\nDATA;\n#1=IFCPROJECT('0$ScRe4drECQ4DMSqUjd6d',$,'P',$,$,$,$,(#2),#3);\n",
    );
    for id in 2..=60u32 {
        // Alternate short and long records so record bodies straddle many
        // candidate boundary offsets.
        if id % 3 == 0 {
            let long_name = "N".repeat(80);
            content.push_str(&format!(
                "#{id}=IFCWALL('{long_name}{id}',$,$,$,$,$,$,$);\n"
            ));
        } else {
            content.push_str(&format!("#{id}=IFCDOOR('g{id}',$,$,$,$,$,$,$);\n"));
        }
    }
    content.push_str("ENDSEC;\nEND-ISO-10303-21;\n");

    // The class oracle below is name-only (`classify_type_name`), so it is
    // ground truth for this fixture only while none of its keywords can take
    // the #1910 instance-level exception that `classify_type_name_with_content`
    // adds on top. Asserted rather than assumed: add a keyword here that IS a
    // spatial container and the oracle would silently start disagreeing with
    // a correct `scan_shard_classified`.
    for keyword in ["IFCPROJECT", "IFCWALL", "IFCDOOR"] {
        assert!(
            !ifc_lite_core::is_representationless_spatial_container_by_name(keyword),
            "fixture keyword {keyword} takes the #1910 instance-level exception, so \
             classify_type_name is no longer a valid oracle for its class byte"
        );
    }
    content
}

/// Compare the two scans' output for identical records (same ids, starts,
/// lengths, i.e. (id, start, end) triples in the same order) and identical
/// handoff over `[range_start, range_end)`, and check that the classified
/// scan's extra `classes` column is positionally aligned with those records.
///
/// The alignment check does NOT compare `classes` against another
/// `scan_shard_classified` call: the host's failure mode is this one function
/// emitting a class column shifted against its own records, and a shift like
/// that lands identically in every range decomposition, so a self-comparison
/// across ranges cannot see it. The oracle is instead recomputed per record
/// from the record's own keyword, which pins each byte to a specific record.
fn assert_shard_scans_match(content: &[u8], range_start: usize, range_end: usize, label: &str) {
    let (plain_records, plain_handoff) = scan_shard(content, range_start, range_end);
    let (classified_records, classes, classified_handoff) =
        scan_shard_classified(content, range_start, range_end);

    assert_eq!(
        plain_records, classified_records,
        "scan_shard vs scan_shard_classified record mismatch for {label} \
         (range [{range_start}, {range_end}))"
    );
    assert_eq!(
        plain_handoff, classified_handoff,
        "scan_shard vs scan_shard_classified handoff mismatch for {label} \
         (range [{range_start}, {range_end}))"
    );
    assert_eq!(
        classes.len(),
        classified_records.len(),
        "scan_shard_classified class column length must match its record count for \
         {label} (range [{range_start}, {range_end})) — the host indexes classes \
         positionally against the records"
    );
    for (i, &(id, start, end)) in classified_records.iter().enumerate() {
        let keyword = keyword_at(content, start, end);
        assert_eq!(
            classes[i],
            classify_type_name(keyword),
            "class byte at index {i} does not belong to the record at that index \
             (#{id} {keyword}) for {label} (range [{range_start}, {range_end})) — \
             the class column is misaligned with the records"
        );
    }
}

/// Whole file scanned as a single shard: the simplest case, and the one the
/// native `build_entity_index_parallel`'s chunk-0 and a one-shard sharded
/// pre-pass both reduce to.
#[test]
fn single_shard_whole_file_matches() {
    let content = synthetic_ifc();
    let bytes = content.as_bytes();
    assert_shard_scans_match(bytes, 0, bytes.len(), "single-shard-whole-file");
}

/// The handoff/stitch case: split the same file into two shards at MANY
/// candidate boundary offsets, sweeping across the whole byte range so at
/// least some boundaries land mid-record (inside a quoted string or between
/// an id and its closing `)`), not just on a `\n`. For every split point,
/// both the first shard `[0, split)` and the second shard `[split, len)` must
/// match between the two functions — this is where a speculative-scan
/// re-sync bug in one loop but not the other would show up.
#[test]
fn shard_boundary_mid_entity_handoff_matches() {
    let content = synthetic_ifc();
    let bytes = content.as_bytes();
    let len = bytes.len();

    let mut checked = 0usize;
    for split in 1..len {
        assert_shard_scans_match(bytes, 0, split, &format!("first-shard@{split}"));
        assert_shard_scans_match(bytes, split, len, &format!("second-shard@{split}"));
        checked += 1;
    }
    assert!(
        checked > 100,
        "sweep must exercise well over 100 boundary positions to have confidence \
         some land mid-entity; only checked {checked}"
    );
}

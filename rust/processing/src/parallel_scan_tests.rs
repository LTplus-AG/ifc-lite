// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Tests for the native parallel scan + handoff stitch (`parallel_scan.rs`).
//!
//! A sibling file rather than an inline `mod tests`, per the house pattern for
//! a module whose bulk is tests (see `stream_meta.rs`), so the production
//! module stays under the ~400-line rule the `module_size_ratchet` enforces.

use super::native::{range_end, with_chunks_counted};
use ifc_lite_core::{build_entity_index, EntityScanner};

/// How many records a SERIAL whole-file scan refuses over `content`.
/// This is the number the sharded path must reproduce: the target is
/// parity with the serial scanner, not immunity to mis-parsing.
fn serial_refusals(content: &[u8]) -> usize {
    let mut scanner = EntityScanner::new(content);
    while scanner.next_entity().is_some() {}
    scanner.skipped_oversized_ids()
}

/// Assert `with_chunks_counted(content, n)` equals the serial index —
/// AND attributes the same number of refusals — for a range of chunk
/// counts. Many `n` means many boundary positions, so a boundary lands
/// inside strings/comments/records across the sweep.
fn assert_parallel_matches_serial(content: &[u8], label: &str) {
    let serial = build_entity_index(content);
    let serial_refused = serial_refusals(content);
    for n in [1usize, 2, 3, 4, 5, 7, 8, 11, 16, 32, 64] {
        let (par, refused) = with_chunks_counted(content, n);
        assert_eq!(
            par, serial,
            "parallel index (n_chunks={n}) != serial for {label}"
        );
        assert_eq!(
            refused, serial_refused,
            "attributed refusals (n_chunks={n}) != serial ({serial_refused}) for {label}"
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

/// Build a file with NOTHING oversized in it whose one long quoted
/// value contains `#4294967297=IFCWALL(` many times over.
///
/// `#4294967297` is `u32::MAX + 2`, and `EntityScanner::next_entity`
/// has no quote context — its only guard is the SHAPE check
/// `#<digits>[ws]*=`, which that text satisfies. A serial scan never
/// looks inside the value (it jumps from the record's `#` straight to
/// the terminating `;` past the string), so the serial refusal count
/// here is ZERO. A shard that STARTS inside the value does look, and
/// refuses every occurrence until it resynchronises.
fn clean_file_with_oversized_shaped_text_in_a_string() -> String {
    let mut fake = String::new();
    for k in 0..400 {
        fake.push_str(&format!(
            "#4294967297=IFCWALL(fake {k} ; still in string "
        ));
    }
    let mut content = String::from("ISO-10303-21;\nHEADER;\nENDSEC;\nDATA;\n");
    content.push_str("#1=IFCPROJECT('guid',$,$,$,$,$,$,$,$);\n");
    content.push_str(&format!("#2=IFCWALL('{fake}',$,$,$,$,$,$,$);\n"));
    for id in 3..=120u32 {
        content.push_str(&format!("#{id}=IFCDOOR('g{id}',$,$,$,$,$,$,$);\n"));
    }
    content.push_str("ENDSEC;\n");
    content
}

/// THE false alarm (#3395/#3430). A file that declares no oversized
/// instance name must report ZERO refusals however the shard
/// boundaries fall — including when one lands inside a string literal
/// that reads like an oversized declaration.
///
/// This is the case the two previous rounds did not have. Summing the
/// per-shard counts (or bounding them by ownership, `start <
/// range_end`) both fail it: the false refusals are parsed out of
/// bytes the owning shard does own, and are dropped only because the
/// stitch discards the speculative prefix they sit in.
#[test]
fn clean_file_with_an_oversized_shaped_string_reports_no_refusal() {
    let content = clean_file_with_oversized_shaped_text_in_a_string();
    let bytes = content.as_bytes();

    // Guard against the assertion below being vacuous from the other
    // side: if the SERIAL scan refused something here, "parallel == 0"
    // would no longer be the claim being tested.
    assert_eq!(
        serial_refusals(bytes),
        0,
        "fixture must declare no oversized id — the serial scan refuses none"
    );

    // And guard against it being vacuous from THIS side: at least one
    // chunk count must actually make a shard start inside the string
    // and refuse something, or the filter is never exercised.
    let mut saw_a_speculative_refusal = false;
    for n in [2usize, 3, 4, 5, 7, 8, 11, 16, 32, 64] {
        let raw: usize = (0..n)
            .map(|i| {
                let start = i * bytes.len() / n;
                let end = range_end(i, n, bytes.len());
                super::scan_shard_with_refusals(bytes, start, end).2.len()
            })
            .sum();
        if raw > 0 {
            saw_a_speculative_refusal = true;
        }
        assert_eq!(
            with_chunks_counted(bytes, n).1,
            0,
            "n_chunks={n}: a file with no oversized id must report no refusal \
             (raw per-shard sum was {raw})"
        );
    }
    assert!(
        saw_a_speculative_refusal,
        "fixture never made a shard refuse a false record — it cannot \
         discriminate the fix from the bug"
    );

    // The index itself is unchanged by any of this.
    assert_parallel_matches_serial(bytes, "clean-file-oversized-shaped-string");
}

/// The other direction: a REAL oversized declaration sitting where the
/// sweep drives boundaries across it is counted exactly once, never
/// twice by two shards and never zero times by a dropped prefix.
#[test]
fn a_real_oversized_id_near_a_boundary_counts_exactly_once() {
    let mut content = String::from("ISO-10303-21;\nHEADER;\nENDSEC;\nDATA;\n");
    for id in 1..=60u32 {
        content.push_str(&format!("#{id}=IFCDOOR('g{id}',$,$,$,$,$,$,$);\n"));
    }
    content.push_str("#4294967297=IFCWALL('over',$,$,$,$,$,$,$);\n");
    for id in 61..=120u32 {
        content.push_str(&format!("#{id}=IFCDOOR('g{id}',$,$,$,$,$,$,$);\n"));
    }
    content.push_str("ENDSEC;\n");
    let bytes = content.as_bytes();

    assert_eq!(serial_refusals(bytes), 1, "one real oversized declaration");
    for n in [1usize, 2, 3, 4, 5, 7, 8, 11, 16, 32, 64] {
        assert_eq!(
            with_chunks_counted(bytes, n).1,
            1,
            "n_chunks={n}: the one real refusal must be counted once"
        );
    }
    // u32::MAX + 2 must not have aliased onto #1 either.
    assert_parallel_matches_serial(bytes, "real-oversized-near-boundary");
}

/// Build a file whose only oversized declaration sits behind a quoted value
/// that a mis-started scan cannot get out of.
///
/// The value carries `#4294967297=IFCWALL(` with neither `'` nor `;` after it
/// until the value closes, so a scan starting in the leading `A` run reads it
/// as a record and then hunts its terminator one quote out of phase for the
/// rest of the file — it emits nothing at all, never reaches the handoff, and
/// forces the stitch onto its serial-rescan arm. Returns the content plus the
/// offsets of the value's record, the handoff record after it, and the real
/// oversized record after that.
fn fixture_behind_an_inescapable_quoted_value(
    pad_to: usize,
    tail_to: usize,
) -> (String, usize, usize, usize) {
    let a = "A".repeat(200);
    let b = "B".repeat(200);
    let mut content = String::from("ISO-10303-21;\nHEADER;\nENDSEC;\nDATA;\n");
    while content.len() < pad_to {
        content.push_str("#1=IFCDOOR('gg',$,$,$,$,$,$,$);\n");
    }
    let record_at = content.len();
    content.push_str(&format!("#5=IFCWALL('{a}#4294967297=IFCWALL({b}',$,$,$,$,$,$,$);\n"));
    let handoff_at = content.len();
    content.push_str("#6=IFCDOOR('g6',$,$,$,$,$,$,$);\n");
    let oversized_at = content.len();
    content.push_str("#4294967297=IFCWALL('over',$,$,$,$,$,$,$);\n");
    while content.len() < tail_to {
        content.push_str("#7=IFCDOOR('gg',$,$,$,$,$,$,$);\n");
    }
    (content, record_at, handoff_at, oversized_at)
}

/// Assert chunk `i` of `n` is one the stitch CANNOT slice: it starts inside
/// the quoted value, reaches past the oversized record, and never emits the
/// handoff. Without this the `Err`-arm tests below would pass on the ordinary
/// `Ok` path and prove nothing about the serial rescan.
fn assert_chunk_cannot_resynchronise(
    bytes: &[u8],
    i: usize,
    n: usize,
    record_at: usize,
    handoff_at: usize,
    oversized_at: usize,
) {
    let chunk_start = i * bytes.len() / n;
    let chunk_end = range_end(i, n, bytes.len());
    assert!(
        chunk_start > record_at && chunk_start < handoff_at,
        "chunk {i}/{n} must start inside the quoted value (got {chunk_start})"
    );
    assert!(
        chunk_end > oversized_at,
        "chunk {i}/{n} must reach past the refusal (end {chunk_end})"
    );
    let (recs, _, _) = super::scan_shard_with_refusals(bytes, chunk_start, chunk_end);
    assert!(
        !recs.iter().any(|&(_, s, _)| s == handoff_at),
        "chunk {i}/{n} must FAIL to resynchronise at the handoff, or the \
         serial-rescan arm is never taken and this test proves nothing"
    );
}

/// The `Err` arm's rescan, stopping at a handoff: `target < end`, so the
/// serial rescan really walks bytes — and one of them is a real oversized
/// declaration.
///
/// The chunk-spanning-record test below only reaches `target >= end`, where
/// `rescan_range` returns at its first entity and can never meet a refusal, so
/// nothing there exercises the count the rescan hands back.
#[test]
fn an_oversized_id_in_a_serially_rescanned_range_counts_once() {
    let (content, record_at, handoff_at, oversized_at) =
        fixture_behind_an_inescapable_quoted_value(2_900, 20_000);
    let bytes = content.as_bytes();

    assert_eq!(serial_refusals(bytes), 1, "one real oversized declaration");
    assert_chunk_cannot_resynchronise(bytes, 2, 13, record_at, handoff_at, oversized_at);

    for n in 2..=40usize {
        assert_eq!(
            with_chunks_counted(bytes, n).1,
            1,
            "n_chunks={n}: the refusal inside the rescanned range, counted once"
        );
    }
    assert_parallel_matches_serial(bytes, "oversized-in-rescanned-range");
}

/// The same rescan, but running off the END of the file: `rescan_range`
/// returns through its EOF arm rather than at a handoff, and that arm reports
/// its refusals separately. A refusal in the file's last chunk would otherwise
/// go unsaid — silence at the tail is still silence.
#[test]
fn an_oversized_id_in_a_rescanned_range_that_hits_eof_counts_once() {
    let (content, record_at, handoff_at, oversized_at) =
        fixture_behind_an_inescapable_quoted_value(17_000, 18_400);
    let bytes = content.as_bytes();

    assert_eq!(serial_refusals(bytes), 1, "one real oversized declaration");
    // The LAST chunk, so its rescan runs to EOF.
    assert_chunk_cannot_resynchronise(bytes, 13, 14, record_at, handoff_at, oversized_at);

    for n in 2..=40usize {
        assert_eq!(
            with_chunks_counted(bytes, n).1,
            1,
            "n_chunks={n}: the refusal in the file's tail, counted once"
        );
    }
    assert_parallel_matches_serial(bytes, "oversized-in-rescanned-tail");
}

/// A real oversized declaration sitting just past a quoted value that
/// swallows chunk boundaries: whichever chunk ends up owning those bytes —
/// via the `Ok` slice or via the serial rescan the `Err` arm falls back to —
/// must count it exactly once, and the false refusals the mis-started chunks
/// made inside the quoted value must not be counted at all.
#[test]
fn a_real_oversized_id_behind_an_adversarial_string_counts_once() {
    let mut fake = String::new();
    for k in 0..400 {
        fake.push_str(&format!("#4294967297=IFCWALL(fake {k} ; still in string "));
    }
    let mut content = String::from("ISO-10303-21;\nHEADER;\nENDSEC;\nDATA;\n");
    content.push_str("#1=IFCPROJECT('guid',$,$,$,$,$,$,$,$);\n");
    content.push_str(&format!("#2=IFCWALL('{fake}',$,$,$,$,$,$,$);\n"));
    content.push_str("#3=IFCDOOR('g3',$,$,$,$,$,$,$);\n");
    content.push_str("#4294967297=IFCWALL('over',$,$,$,$,$,$,$);\n");
    for id in 4..=120u32 {
        content.push_str(&format!("#{id}=IFCDOOR('g{id}',$,$,$,$,$,$,$);\n"));
    }
    content.push_str("ENDSEC;\n");
    let bytes = content.as_bytes();

    assert_eq!(serial_refusals(bytes), 1, "one real oversized declaration");
    for n in [1usize, 2, 3, 4, 5, 7, 8, 11, 16, 32, 64] {
        assert_eq!(
            with_chunks_counted(bytes, n).1,
            1,
            "n_chunks={n}: exactly the one real refusal, none of the in-string ones"
        );
    }
    assert_parallel_matches_serial(bytes, "real-oversized-behind-adversarial-string");
}

/// The refusal accounting on the FALLBACK path, which the `Ok`-path tests
/// never reach.
///
/// When a chunk's records do not contain the previous chunk's handoff (here:
/// a single record spans several whole chunks), the stitch throws that chunk
/// away and rescans its bytes serially. The chunk's own refusals go with it —
/// they were parsed from a mid-string start — and the rescan's are what count.
/// A real oversized declaration sitting in the rescanned bytes must therefore
/// still be reported, exactly once.
#[test]
fn an_oversized_id_after_a_chunk_spanning_record_counts_once() {
    let big_name = "X".repeat(20_000);
    let mut content = String::from("DATA;\n");
    content.push_str("#1=IFCPROJECT('g',$,$,$,$,$,$,$,$);\n");
    content.push_str(&format!("#2=IFCWALL('{big_name}',$,$,$,$,$,$,$);\n"));
    content.push_str("#4294967297=IFCWALL('over',$,$,$,$,$,$,$);\n");
    for id in 3..=40u32 {
        content.push_str(&format!("#{id}=IFCDOOR('g{id}',$,$,$,$,$,$,$);\n"));
    }
    let bytes = content.as_bytes();

    assert_eq!(serial_refusals(bytes), 1, "one real oversized declaration");
    for n in [1usize, 2, 3, 4, 5, 7, 8, 11, 16, 32, 64] {
        assert_eq!(
            with_chunks_counted(bytes, n).1,
            1,
            "n_chunks={n}: the refusal in the rescanned range must be counted once"
        );
    }
    assert_parallel_matches_serial(bytes, "oversized-after-chunk-spanning-record");
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
///
/// `ara3d/AC-20-Smiley-West-10-Bldg.ifc` was the original third leg but is
/// not, and never was, in `tests/models/manifest.json` — `pnpm fixtures`
/// cannot fetch it, so this leg silently never ran. Swapped for
/// `ara3d/advanced_model.ifc` (35MB, in the manifest), which serves the
/// same role: a third large, structurally distinct real model. The test
/// is model-agnostic (byte-identical parallel-vs-serial STEP scan), so any
/// large real fixture exercises the same property.
#[test]
fn fixtures_byte_identical() {
    for rel in [
        "ara3d/schependomlaan.ifc",
        "ara3d/advanced_model.ifc",
        "various/01_BIMcollab_Example_ARC.ifc",
    ] {
        let path = format!("{}/../../tests/models/{}", env!("CARGO_MANIFEST_DIR"), rel);
        let Ok(content) = std::fs::read(&path) else {
            eprintln!("skipping {rel}: fixture absent — run `pnpm fixtures`");
            continue;
        };
        assert_parallel_matches_serial(&content, rel);
        assert_eq!(
            super::build_entity_index_parallel(&content),
            build_entity_index(&content),
            "public build_entity_index_parallel != serial for {rel}"
        );
    }
}

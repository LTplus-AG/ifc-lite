// SPDX-License-Identifier: MPL-2.0
//! Tests for `step_text.rs`, split out under the house pattern (AGENTS.md).
//!
//! Moved out so the production module stays under the module-size ratchet
//! (`rust/processing/tests/module_size_ratchet.rs`); this file is exempt via
//! the `_tests.rs` suffix convention.

use super::*;

/// End-to-end scenario for the same seam through the real `export_step`
/// path: a source file whose `FILE_SCHEMA` label carries a literal `\`,
/// exported with no explicit target schema (so `step.rs:196` falls back to
/// `source_schema` and `step.rs:217` re-escapes it), must round-trip the
/// label instead of compounding the escape.
#[test]
fn export_step_round_trips_a_backslash_carrying_schema_label_through_source_schema_fallback() {
    use crate::step::{export_step_with_stats, StepOptions};

    let source = b"ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION((''),'2;1');\nFILE_NAME('','',(''),(''),'','','');\nFILE_SCHEMA(('IFC\\\\4'));\nENDSEC;\nDATA;\n#1=IFCPROJECT('guid',$,$,$,$,$,$,$,$);\nENDSEC;\nEND-ISO-10303-21;\n";

    let (step, _stats) = export_step_with_stats(source, &StepOptions::default());
    let schema_line = step
        .lines()
        .find(|l| l.starts_with("FILE_SCHEMA("))
        .expect("a FILE_SCHEMA header line");
    assert_eq!(
        schema_line, "FILE_SCHEMA(('IFC\\\\4'));",
        "source schema label must round-trip, not compound its escaping"
    );
}

#[test]
fn split_top_level_args_respects_nesting() {
    let args = "'a',$,(#1,#2,#3),IFCBOOLEAN(.T.),#9";
    let parts = split_top_level_args(args);
    assert_eq!(parts.len(), 5);
    assert_eq!(parts[2], "(#1,#2,#3)");
    assert_eq!(parts[3], "IFCBOOLEAN(.T.)");
}

// The `escape()` literal-table tests that used to live here (backslash
// doubling, apostrophe+backslash ordering, per-char control mapping, run
// length, byte-identical plain text, non-ASCII directive encoding) are now
// the shared vectors in `tests/fixtures/step_escape_vectors.json`, pinned by
// `tests/step_escape_parity.rs` -- the same file the TypeScript escaper
// (`packages/data/src/step-serializers.ts`) is pinned to via
// `packages/data/src/step-escape.parity.test.ts` (#3300, second half). A
// hand-kept copy of the other language's behaviour only resets the clock on
// the drift it exists to catch (the reasoning behind the CSV-cell-escaper
// precedent this follows: `csv_cell_vectors.json` / `csv_cell_parity.rs`).

/// End-to-end write-side round-trip for the ISO 10303-21 doubling escapes.
///
/// ifc-lite's own reader (`ifc_lite_core::step_encoding::decode_ifc_string`
/// / the tokenizer) does not yet collapse `''` or `\\` on this branch — that
/// half is tracked separately and lands on its own branch, not here. So
/// this test does not round-trip through ifc-lite's reader (that would
/// conflate two different bugs); instead it applies the ISO 10303-21 spec
/// rule directly — the STEP standard's un-doubling, independent of what
/// any particular reader currently implements — to the raw bytes this
/// exporter wrote, and asserts the original string comes back. That is
/// the write side's actual contract: emit a spec-conformant file.
#[test]
fn property_synthesis_round_trips_apostrophe_and_backslash_per_spec() {
    use crate::step::{export_step_with_stats, PropMutation, StepOptions};
    use ifc_lite_core::EntityScanner;

    // A STRICT ISO 10303-21 6.3.2.4/6.3.2.5 un-escaper: every literal `'`
    // and `\` in the string's plain-text value MUST appear doubled in the
    // literal. A run of backslashes with an ODD length is malformed under
    // that rule (an un-doubled backslash is not distinguishable from the
    // start of some other escape directive) — a real conformant reader is
    // entitled to reject it, so this panics rather than silently passing
    // it through. That is what makes this test discriminating: a writer
    // that forgets to double `\` produces odd-length runs here, not a
    // string that "happens to" spec-unescape back to the original.
    fn spec_unescape(quoted_body: &str) -> String {
        let mut out = String::with_capacity(quoted_body.len());
        let bytes = quoted_body.as_bytes();
        let mut i = 0;
        while i < bytes.len() {
            if bytes[i] == b'\'' {
                assert_eq!(
                    bytes.get(i + 1),
                    Some(&b'\''),
                    "malformed STEP literal: un-doubled apostrophe at byte {i} in {quoted_body:?}"
                );
                out.push('\'');
                i += 2;
            } else if bytes[i] == b'\\' {
                let mut run = 0usize;
                while bytes.get(i + run) == Some(&b'\\') {
                    run += 1;
                }
                assert_eq!(
                    run % 2,
                    0,
                    "malformed STEP literal: odd-length ({run}) backslash run at byte {i} in {quoted_body:?} — a real reader can't tell whether this is a doubled reverse solidus or the start of an escape directive"
                );
                for _ in 0..run / 2 {
                    out.push('\\');
                }
                i += run;
            } else {
                out.push(bytes[i] as char);
                i += 1;
            }
        }
        out
    }

    let src = fixture_or_skip!("ara3d/duplex.ifc");
    let mut scanner = EntityScanner::new(&src[..]);
    let mut wall = None;
    while let Some((id, t, _s, _e)) = scanner.next_entity() {
        if t.eq_ignore_ascii_case("IFCWALLSTANDARDCASE") {
            wall = Some(id);
            break;
        }
    }
    let wall = wall.expect("a wall");

    let original_pset_name = r"O'Brien\Docs\Pset";
    let (step, _stats) = export_step_with_stats(
        &src,
        &StepOptions {
            property_mutations: vec![PropMutation {
                express_id: wall,
                pset_name: original_pset_name.to_string(),
                prop_name: "MyProp".to_string(),
                value: "IFCLABEL('hello')".to_string(),
            }],
            ..StepOptions::default()
        },
    );

    // Locate the synthesized IFCPROPERTYSET line and pull its (still-quoted)
    // name field: `IFCPROPERTYSET('<guid>',$,'<pset_name>',$,(...))` — the
    // NAME is the second quoted field, after the placeholder GUID.
    let pset_line = step
        .lines()
        .find(|l| l.contains("=IFCPROPERTYSET(") && l.contains("Brien"))
        .expect("synthesized pset line present");

    // Scan quoted-string fields left to right (skipping doubled '' pairs
    // inside each), returning the raw body between the Nth pair of quotes.
    fn nth_quoted_body(line: &str, n: usize) -> &str {
        let bytes = line.as_bytes();
        let mut i = 0;
        let mut found = 0;
        while i < bytes.len() {
            if bytes[i] == b'\'' {
                let start = i + 1;
                let mut j = start;
                loop {
                    if bytes[j] == b'\'' {
                        if bytes.get(j + 1) == Some(&b'\'') {
                            j += 2;
                            continue;
                        }
                        break;
                    }
                    j += 1;
                }
                if found == n {
                    return &line[start..j];
                }
                found += 1;
                i = j + 1;
            } else {
                i += 1;
            }
        }
        panic!("fewer than {n} quoted fields in: {line}");
    }
    let raw_quoted_body = nth_quoted_body(pset_line, 1);

    assert_eq!(
        spec_unescape(raw_quoted_body),
        original_pset_name,
        "raw written bytes {raw_quoted_body:?} must spec-un-escape back to the original"
    );
}

/// Control: an ordinary express id is collected unchanged (issue #3421).
/// `refs_in_line` collects every `#<digits>` in the line, including the
/// record's own leading `#<id>=` — callers are expected to filter that
/// themselves, the same as `parse_express_id`'s contract upstream.
#[test]
fn refs_in_line_collects_an_ordinary_ref() {
    let mut out = Vec::new();
    refs_in_line(b"#1=IFCWALL(#42,#137924);", &mut out);
    assert_eq!(out, vec![1, 42, 137924]);
}

/// Boundary: a ref at exactly `u32::MAX` is not refused (issue #3421).
#[test]
fn refs_in_line_accepts_a_ref_at_exactly_u32_max() {
    let mut out = Vec::new();
    refs_in_line(b"#1=IFCWALL(#4294967295);", &mut out);
    assert_eq!(out, vec![1, u32::MAX]);
}

/// RED for issue #3421: a ref one past `u32::MAX` used to wrap
/// (`4294967296` accumulated onto `0`, and `4294967297` onto `1`) and bind to
/// a real low-numbered entity instead of refusing. It must now be dropped
/// from the reference list rather than aliased onto id 0 or 1.
#[test]
fn refs_in_line_refuses_a_ref_above_u32_max_instead_of_wrapping_onto_a_real_entity() {
    let mut out = Vec::new();
    refs_in_line(b"#1=IFCWALL(#4294967296,#4294967297,#42);", &mut out);
    assert_eq!(
        out,
        vec![1, 42],
        "an oversized ref must be dropped, never aliased onto id 0 or 1 (id 1 here is the record's own leading id, not an alias)"
    );
}

/// RED for issue #3752: `refs_in_line` silently dropped an oversized ref with
/// no trace. `refs_in_line_counted` must count exactly the two refused refs
/// from the fixture above (`#4294967296` and `#4294967297`), not the two
/// accepted ones (`#1`, `#42`).
#[test]
fn refs_in_line_counted_counts_the_refused_refs_not_the_accepted_ones() {
    let mut out = Vec::new();
    let mut refused = 0usize;
    refs_in_line_counted(b"#1=IFCWALL(#4294967296,#4294967297,#42);", &mut out, &mut refused);
    assert_eq!(out, vec![1, 42]);
    assert_eq!(refused, 2, "both oversized refs must be counted (#3752)");
}

/// Control: an ordinary line reports zero refusals.
#[test]
fn refs_in_line_counted_reports_no_refusals_for_an_ordinary_line() {
    let mut out = Vec::new();
    let mut refused = 0usize;
    refs_in_line_counted(b"#1=IFCWALL(#42,#137924);", &mut out, &mut refused);
    assert_eq!(refused, 0, "an ordinary line must not be counted as refused");
}

/// Boundary: a ref at exactly `u32::MAX` is not counted as refused.
#[test]
fn refs_in_line_counted_reports_no_refusals_at_exactly_u32_max() {
    let mut out = Vec::new();
    let mut refused = 0usize;
    refs_in_line_counted(b"#1=IFCWALL(#4294967295);", &mut out, &mut refused);
    assert_eq!(refused, 0, "a ref at exactly u32::MAX must not be counted as refused");
}

/// End-to-end RED for issue #3752, through the real `export_step_with_stats`
/// entry point: a filtered export (`opts.included`) whose root references an
/// oversized id must surface it in `StepStats.refused_refs`, not just drop it
/// from the reference closure with no trace.
#[test]
fn export_step_with_stats_reports_refused_refs_in_a_filtered_export() {
    use crate::step::{export_step_with_stats, StepOptions};

    let source = b"ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION((''),'2;1');\nFILE_NAME('','',(''),(''),'','','');\nFILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\n\
                   #1=IFCWALL('g',$,$,$,$,#4294967297,$,$,$);\n\
                   #2=IFCWALL('g2',$,$,$,$,#42,$,$,$);\n\
                   #42=IFCLOCALPLACEMENT($,$);\nENDSEC;\nEND-ISO-10303-21;\n";

    let (_step, stats) = export_step_with_stats(
        source,
        &StepOptions { included: Some(vec![1]), ..StepOptions::default() },
    );
    assert_eq!(
        stats.refused_refs, 1,
        "the oversized reference on #1 must be counted, not silently dropped (#3752)"
    );

    // Control: the same shape rooted at #2 (an ordinary reference) reports zero.
    let (_step, control_stats) = export_step_with_stats(
        source,
        &StepOptions { included: Some(vec![2]), ..StepOptions::default() },
    );
    assert_eq!(
        control_stats.refused_refs, 0,
        "an ordinary reference must not be counted as refused"
    );
}

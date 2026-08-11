// SPDX-License-Identifier: MPL-2.0
//! Tests for `merged.rs`, split out under the house pattern (AGENTS.md).
//!
//! Moved out so the production module stays under the module-size ratchet
//! (`rust/processing/tests/module_size_ratchet.rs`); this file is exempt via
//! the `_tests.rs` suffix convention.

use super::*;

fn fixture(rel: &str) -> Vec<u8> {
    let path = format!("{}/../../tests/models/{}", env!("CARGO_MANIFEST_DIR"), rel);
    std::fs::read(&path).unwrap_or_else(|e| panic!("read {path}: {e}"))
}

fn scan_ids(step: &str) -> Vec<u32> {
    let bytes = step.as_bytes();
    let mut ids = Vec::new();
    let mut scanner = EntityScanner::new(bytes);
    while let Some((id, _t, _s, _e)) = scanner.next_entity() {
        ids.push(id);
    }
    ids
}

#[test]
fn merge_two_models_unifies_project_and_offsets_ids() {
    let a = fixture("ara3d/duplex.ifc");
    let single = scan_ids(&String::from_utf8_lossy(&a)).len();

    let (merged, stats) = export_merged_with_stats(&[&a, &a], &MergedOptions::default());
    assert_eq!(stats.models, 2);

    let ids = scan_ids(&merged);
    // Every express id is unique after offsetting (no collisions across models).
    let mut sorted = ids.clone();
    sorted.sort_unstable();
    sorted.dedup();
    assert_eq!(sorted.len(), ids.len(), "ids are globally unique after merge");

    // Exactly one IfcProject survives (second model's was dropped + redirected).
    let projects = merged.lines().filter(|l| l.contains("=IFCPROJECT(")).count();
    assert_eq!(projects, 1, "single unified project");

    // Two models minus one dropped project ≈ 2*single - 1 entities.
    assert_eq!(stats.written, single * 2 - 1);

    // No dangling references: every #ref resolves to a written id.
    let idset: std::collections::HashSet<u32> = ids.into_iter().collect();
    for line in merged.lines().filter(|l| l.starts_with('#')) {
        // collect refs after the leading id
        let body = &line[1..];
        let after_eq = body.find('=').map(|e| &body[e..]).unwrap_or(body);
        let mut i = 0;
        let bytes = after_eq.as_bytes();
        let mut in_str = false;
        while i < bytes.len() {
            let c = bytes[i];
            if c == b'\'' {
                in_str = !in_str;
            } else if !in_str && c == b'#' {
                let mut j = i + 1;
                let mut n = 0u32;
                let mut any = false;
                while j < bytes.len() && bytes[j].is_ascii_digit() {
                    n = n * 10 + (bytes[j] - b'0') as u32;
                    j += 1;
                    any = true;
                }
                if any {
                    assert!(idset.contains(&n), "dangling ref #{n}");
                    i = j;
                    continue;
                }
            }
            i += 1;
        }
    }
}
// `escape()` and `detect_schema()` are no longer private forks of this
// module: `merged.rs` imports both from `step_text.rs` (the same primitives
// `step.rs` uses), so their unit coverage lives in `step_text_tests.rs`
// (including the control-char mapping and the 4096-byte-cutoff /
// quote-blind FILE_SCHEMA-scan fixes that this module used to lack). What
// remains here is `merged.rs`-specific: that the shared primitives are
// actually wired into the merged export path end-to-end.

/// Scenario from the maintainer's review: a header field (FILE_DESCRIPTION)
/// long enough to push FILE_SCHEMA past the old 4096-byte cutoff must still
/// resolve the real schema through the merged export path, not silently
/// fall back to the IFC4 default.
#[test]
fn merge_detects_schema_past_the_old_4096_byte_cutoff() {
    let padding = "x".repeat(5000);
    let content = format!(
        "ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION(('{padding}'),'2;1');\nFILE_SCHEMA(('IFC2X3'));\nENDSEC;\nDATA;\n#1=IFCPROJECT('guid',$,$,$,$,$,$,$,$);\nENDSEC;\nEND-ISO-10303-21;\n"
    );
    assert!(
        content.len() > 4096,
        "test fixture must exceed the old 4096-byte cutoff"
    );
    let (merged, _stats) =
        export_merged_with_stats(&[content.as_bytes()], &MergedOptions::default());
    let schema_line = merged
        .lines()
        .find(|l| l.starts_with("FILE_SCHEMA("))
        .expect("a FILE_SCHEMA header line");
    assert_eq!(schema_line, "FILE_SCHEMA(('IFC2X3'));");
}

/// Scenario from the maintainer's review: a header field whose string VALUE
/// happens to contain the literal text `FILE_SCHEMA` must not be mistaken
/// for the real entry by a quote-blind scan.
#[test]
fn merge_ignores_file_schema_literal_text_inside_a_quoted_header_string() {
    let content = "ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION(('mentions FILE_SCHEMA in passing'),'2;1');\nFILE_SCHEMA(('IFC4X3'));\nENDSEC;\nDATA;\n#1=IFCPROJECT('guid',$,$,$,$,$,$,$,$);\nENDSEC;\nEND-ISO-10303-21;\n";
    let (merged, _stats) =
        export_merged_with_stats(&[content.as_bytes()], &MergedOptions::default());
    let schema_line = merged
        .lines()
        .find(|l| l.starts_with("FILE_SCHEMA("))
        .expect("a FILE_SCHEMA header line");
    assert_eq!(schema_line, "FILE_SCHEMA(('IFC4X3'));");
}

/// Scenario from the maintainer's review: a header field carrying a raw C0
/// control byte (outside the ISO 10303-21 basic graphic range 32-126) must
/// be mapped to a space, not written raw into the STEP literal. Only \n \r
/// \t were mapped before merged.rs picked up the shared `step_text::escape`.
#[test]
fn merge_maps_raw_control_bytes_in_header_fields_to_a_space() {
    let opts = MergedOptions {
        schema: Some("IFC4".to_string()),
        description: "ViewDefinition [CoordinationView]".to_string(),
        application: "app\u{07}bell\u{0B}vt".to_string(),
    };
    let content = "ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION((''),'2;1');\nFILE_NAME('','',(''),(''),'','','');\nFILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\n#1=IFCPROJECT('guid',$,$,$,$,$,$,$,$);\nENDSEC;\nEND-ISO-10303-21;\n";
    let (merged, _stats) = export_merged_with_stats(&[content.as_bytes()], &opts);
    let file_name_line = merged
        .lines()
        .find(|l| l.starts_with("FILE_NAME("))
        .expect("a FILE_NAME header line");
    assert!(
        !file_name_line.contains('\u{07}') && !file_name_line.contains('\u{0B}'),
        "raw control bytes must not reach the STEP literal: {file_name_line:?}"
    );
    assert_eq!(
        file_name_line,
        "FILE_NAME('','',(''),(''),'app bell vt','ifc-lite-export','');"
    );
}

/// End-to-end write-side check for the ISO 10303-21 doubling escapes, on
/// the header fields `escape()` actually feeds (FILE_NAME's application
/// field). Applies the spec's un-doubling rule directly to the raw
/// written bytes: a run of backslashes with an ODD length is malformed
/// (a real reader can't tell whether a lone `\` starts an escape
/// directive or is meant literally), so this panics rather than
/// silently accepting under-escaped output.
#[test]
fn header_fields_round_trip_apostrophe_and_backslash_per_spec() {
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
                    "malformed STEP literal: odd-length ({run}) backslash run at byte {i} in {quoted_body:?} -- a real reader can't tell whether this is a doubled reverse solidus or the start of an escape directive"
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

    let opts = MergedOptions {
        schema: Some("IFC4".to_string()),
        description: "ViewDefinition [CoordinationView]".to_string(),
        application: r"O'Brien\Docs\ifc-lite".to_string(),
    };
    let a = fixture("ara3d/duplex.ifc");
    let (step, _stats) = export_merged_with_stats(&[&a], &opts);

    // Pull the quoted application field out of
    // FILE_NAME('','',(''),(''),'<app>','ifc-lite-export','');
    let line = step
        .lines()
        .find(|l| l.starts_with("FILE_NAME("))
        .expect("a FILE_NAME header line");
    let start_marker = "(''),'";
    let end_marker = "','ifc-lite-export'";
    let q0 = line.find(start_marker).expect("app field start") + start_marker.len();
    let q1 = line.rfind(end_marker).expect("app field terminator");
    let raw_app = &line[q0..q1];

    assert_eq!(spec_unescape(raw_app), opts.application);
}

/// Round-trip pin: a DATA-section string literal carrying every STEP
/// escape shape (a doubled apostrophe `''`, a doubled reverse solidus
/// `\\`, and a `\X2\...\X0\` UCS-2 directive) must survive the merged
/// exporter byte-for-byte. `rewrite_refs` treats string content as
/// opaque bytes -- it only tracks in/out-of-string state (via the same
/// doubled-apostrophe toggle trick as the scanner) to protect `#`
/// references from being rewritten inside a literal -- so it must never
/// decode, re-encode, or otherwise touch the literal's bytes.
#[test]
fn data_section_string_literal_round_trips_every_escape_shape_byte_for_byte() {
    // \X2\0041\X0\ is the UCS-2 directive for 'A'; combined with a
    // doubled apostrophe and a doubled reverse solidus this exercises
    // all three escape shapes named in the review discussion.
    let name_literal = r"O''Brien\\Docs\X2\0041\X0\";
    let content = format!(
        "ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION((''),'2;1');\nFILE_NAME('','',(''),(''),'','','');\nFILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\n#1=IFCPROJECT('guid',$,'{name_literal}',$,$,$,$,$,$);\nENDSEC;\nEND-ISO-10303-21;\n"
    );

    let (merged, _stats) = export_merged_with_stats(&[content.as_bytes()], &MergedOptions::default());

    let expected_line = format!("#1=IFCPROJECT('guid',$,'{name_literal}',$,$,$,$,$,$);");
    let actual_line = merged
        .lines()
        .find(|l| l.starts_with("#1="))
        .expect("the IFCPROJECT data line");
    assert_eq!(
        actual_line, expected_line,
        "DATA-section string literal must pass through byte-for-byte, undecoded and unre-encoded"
    );
}

/// The ASCII-only pin above cannot see a real corruption class: `rewrite_refs`
/// used to build its output with `out.push(b as char)`, a byte->char cast
/// that Latin-1-expands every raw byte >= 0x80. A UTF-8 multi-byte sequence
/// in a DATA-section literal (e.g. non-ASCII text in an `IfcLabel`) would
/// come out mojibaked even though the PR's "byte-opaque" claim promised
/// otherwise. Reproduces the maintainer's exact failure scenario.
#[test]
fn data_section_string_literal_round_trips_non_ascii_utf8_byte_for_byte() {
    let name_literal = "Größe 中"; // exact repro string from the review
    let content = format!(
        "ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION((''),'2;1');\nFILE_NAME('','',(''),(''),'','','');\nFILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\n#1=IFCPROJECT('guid',$,'{name_literal}',$,$,$,$,$,$);\nENDSEC;\nEND-ISO-10303-21;\n"
    );

    let (merged, _stats) =
        export_merged_with_stats(&[content.as_bytes()], &MergedOptions::default());

    let expected_line = format!("#1=IFCPROJECT('guid',$,'{name_literal}',$,$,$,$,$,$);");
    let actual_line = merged
        .lines()
        .find(|l| l.starts_with("#1="))
        .expect("the IFCPROJECT data line");
    assert_eq!(
        actual_line, expected_line,
        "non-ASCII UTF-8 bytes in a DATA-section literal must not be mojibaked"
    );
}

/// `detect_schema` (now the shared `step_text::detect_schema`, imported
/// rather than forked in this module) extracts the RAW (still
/// STEP-escaped) text between the first two apostrophes following
/// `FILE_SCHEMA`. That text is then fed straight into `escape()` when the
/// header is re-written, which doubles `\` again -- so `detect_schema`
/// must un-double `\\` itself first, or a schema label carrying a literal
/// `\` would round-trip corrupted (four backslashes out for two in). No
/// real schema label (IFC2X3, IFC4, IFC4X3_ADD2, ...) contains a
/// backslash, so this never fires on a real file; this test proves the
/// un-double -> re-escape seam is correct with a synthetic label, exercised
/// here through the merged export path (the primitive itself is pinned in
/// `step_text_tests.rs`, including its `export_step` counterpart).
#[test]
fn detect_schema_un_doubles_backslash_before_escape_re_doubles_it() {
    // A schema label no real file would ever carry, built solely to
    // exercise the detect_schema -> escape() seam.
    let source = "ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION((''),'2;1');\nFILE_NAME('','',(''),(''),'','','');\nFILE_SCHEMA(('IFC\\\\4'));\nENDSEC;\nDATA;\nENDSEC;\nEND-ISO-10303-21;\n";

    // detect_schema un-doubles the raw slice's backslash run before
    // returning: the two-backslash STEP encoding of a single literal
    // backslash comes back decoded to one backslash.
    assert_eq!(detect_schema(source.as_bytes()), "IFC\\4");

    let (merged, _stats) =
        export_merged_with_stats(&[source.as_bytes()], &MergedOptions::default());
    let schema_line = merged
        .lines()
        .find(|l| l.starts_with("FILE_SCHEMA("))
        .expect("a FILE_SCHEMA header line");

    // escape() re-doubles the now-decoded single backslash back to two,
    // matching what was in the source: the header round-trips instead of
    // compounding.
    assert_eq!(schema_line, "FILE_SCHEMA(('IFC\\\\4'));");
}

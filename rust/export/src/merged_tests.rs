// SPDX-License-Identifier: MPL-2.0
//! Tests for `merged.rs`, split out under the house pattern (AGENTS.md).
//!
//! Moved out so the production module stays under the module-size ratchet
//! (`rust/processing/tests/module_size_ratchet.rs`); this file is exempt via
//! the `_tests.rs` suffix convention.

use super::*;

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
    let a = fixture_or_skip!("ara3d/duplex.ifc");
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
        included: None,
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
        included: None,
    };
    let a = fixture_or_skip!("ara3d/duplex.ifc");
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

/// Reproduces the issue's headline defect: two federated models that share a
/// GlobalId (a linked/shared element loaded into both models -- the common
/// "same file merged twice" and "shared door type" cases) must not emit that
/// GlobalId twice into the output STEP text. Distinct groups with distinct
/// counts so nothing passes by coincidence:
///   - 3 entities whose GlobalId is IDENTICAL across both models (a shared
///     `IFCDOOR` -- same real-world element, referenced from both models).
///   - 2 entities per model (4 total) whose GlobalId is genuinely UNIQUE to
///     that model (ordinary walls/spaces -- no collision).
///
/// All six entities here are genuine `IfcRoot` subtypes (`IFCDOOR`,
/// `IFCWALL`, `IFCSPACE`) with their GlobalId as the true first attribute --
/// unlike the fixture this replaced, which stood `IFCGRIDAXIS` in for a
/// "GlobalId" using its `AxisTag` attribute. `IfcGridAxis` is NOT an
/// `IfcRoot` subtype, so that fixture only exercised reconciliation because
/// of the exact bug this file now fixes: it passed for the wrong reason,
/// on a type the fixed `leading_guid` correctly stops reconciling (see
/// `merge_never_corrupts_a_non_rooted_string_that_looks_like_a_globalid`
/// below for the corruption that fixture was masking).
///
/// Assertion is against the emitted STEP text itself (`.matches(guid).count()`),
/// not an intermediate map -- this is the shape a reader/writer round-trip
/// through our own tooling could not catch (both sides would agree on the
/// same misreading of an intermediate structure).
#[test]
fn merge_two_models_never_emit_a_shared_globalid_twice_in_the_output_text() {
    // 22-char buildingSMART-alphabet GlobalIds, distinguishable by name.
    let shared_door_a = "00000000000000000000A1";
    let shared_door_b = "00000000000000000000B2";
    let shared_door_c = "00000000000000000000C3";
    let model1_wall = "11111111111111111111W1";
    let model1_space = "11111111111111111111S1";
    let model2_wall = "22222222222222222222W2";
    let model2_space = "22222222222222222222S2";

    let model_a = format!(
        "ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION((''),'2;1');\nFILE_NAME('','',(''),(''),'','','');\nFILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\n\
#1=IFCPROJECT('proja',$,$,$,$,$,$,$,$);\n\
#2=IFCDOOR('{shared_door_a}',$,$,$,$,$,$,$,$);\n\
#3=IFCDOOR('{shared_door_b}',$,$,$,$,$,$,$,$);\n\
#4=IFCDOOR('{shared_door_c}',$,$,$,$,$,$,$,$);\n\
#5=IFCWALL('{model1_wall}',$,$,$,$,$,$,$,$);\n\
#6=IFCSPACE('{model1_space}',$,$,$,$,$,$,$,$,$);\n\
ENDSEC;\nEND-ISO-10303-21;\n"
    );
    let model_b = format!(
        "ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION((''),'2;1');\nFILE_NAME('','',(''),(''),'','','');\nFILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\n\
#1=IFCPROJECT('projb',$,$,$,$,$,$,$,$);\n\
#2=IFCDOOR('{shared_door_a}',$,$,$,$,$,$,$,$);\n\
#3=IFCDOOR('{shared_door_b}',$,$,$,$,$,$,$,$);\n\
#4=IFCDOOR('{shared_door_c}',$,$,$,$,$,$,$,$);\n\
#5=IFCWALL('{model2_wall}',$,$,$,$,$,$,$,$);\n\
#6=IFCSPACE('{model2_space}',$,$,$,$,$,$,$,$,$);\n\
ENDSEC;\nEND-ISO-10303-21;\n"
    );

    let (merged, _stats) =
        export_merged_with_stats(&[model_a.as_bytes(), model_b.as_bytes()], &MergedOptions::default());

    // The 3 shared-door GlobalIds must appear exactly once each in the
    // output text -- not twice, even though both source models carried them.
    for guid in [shared_door_a, shared_door_b, shared_door_c] {
        assert_eq!(
            merged.matches(guid).count(),
            1,
            "shared GlobalId {guid} must be emitted exactly once, not duplicated across federated models"
        );
    }

    // The 4 legitimately-distinct GlobalIds (2 per model) must each survive
    // unchanged -- exactly one occurrence, no collision to reconcile.
    for guid in [model1_wall, model1_space, model2_wall, model2_space] {
        assert_eq!(
            merged.matches(guid).count(),
            1,
            "non-colliding GlobalId {guid} must survive unchanged"
        );
    }

    // Overall: 7 distinct GlobalIds (3 shared + 4 unique) must appear in the
    // output -- one occurrence each, 7 total occurrences of *some* 22-char
    // GlobalId-shaped token from our fixture set. This distinct count check
    // (7, not 10) is what would fail if collisions were silently duplicated
    // instead of reconciled.
    let total_occurrences: usize = [
        shared_door_a, shared_door_b, shared_door_c,
        model1_wall, model1_space, model2_wall, model2_space,
    ]
    .iter()
    .map(|g| merged.matches(*g).count())
    .sum();
    assert_eq!(total_occurrences, 7, "7 distinct GlobalIds, one occurrence each");
}

// ---------------------------------------------------------------------------
// Visibility filtering (#2951 parity increment)
// ---------------------------------------------------------------------------

/// Two federated models, each independently visibility-filtered via
/// `MergedOptions.included`, with DIFFERENT included/excluded counts per
/// model so a filter that silently no-ops (or applies globally instead of
/// per-model) cannot pass by coincidence:
///
///   - Model A: 3 walls -- 2 included, 1 excluded -- plus a property set
///     attached ONLY to the excluded wall via an `IFCRELDEFINESBYPROPERTIES`
///     that names BOTH the excluded wall and the pset. That relationship
///     spans an included/excluded boundary (its own id is a root, one of its
///     two references is excluded) -- the case that would dangle a `#ref` if
///     the line were emitted verbatim.
///   - Model B: 2 walls -- 1 included, 1 excluded -- independently filtered,
///     proving model A's exclusion list has no effect on model B (the entity
///     excluded from A is a distinct GlobalId from the one excluded in B,
///     and B's excluded wall is a DIFFERENT id/count shape than A's).
#[test]
fn visibility_filter_excludes_per_model_and_drops_the_dangling_relationship() {
    let a_vis1 = "AAAAAAAAAAAAAAAAAAAAV1";
    let a_vis2 = "AAAAAAAAAAAAAAAAAAAAV2";
    let a_hidden = "AAAAAAAAAAAAAAAAAAAAHD";
    let b_vis1 = "BBBBBBBBBBBBBBBBBBBBV1";
    let b_hidden = "BBBBBBBBBBBBBBBBBBBBHD";

    let model_a = format!(
        "ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION((''),'2;1');\nFILE_NAME('','',(''),(''),'','','');\nFILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\n\
#1=IFCPROJECT('proja',$,$,$,$,$,$,$,$);\n\
#2=IFCWALL('{a_vis1}',$,$,$,$,$,$,$,$);\n\
#3=IFCWALL('{a_vis2}',$,$,$,$,$,$,$,$);\n\
#4=IFCWALL('{a_hidden}',$,$,$,$,$,$,$,$);\n\
#5=IFCPROPERTYSET('pset-a',$,$,$,$);\n\
#6=IFCRELDEFINESBYPROPERTIES('rel-a',$,$,$,(#4),#5);\n\
ENDSEC;\nEND-ISO-10303-21;\n"
    );
    let model_b = format!(
        "ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION((''),'2;1');\nFILE_NAME('','',(''),(''),'','','');\nFILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\n\
#1=IFCPROJECT('projb',$,$,$,$,$,$,$,$);\n\
#2=IFCWALL('{b_vis1}',$,$,$,$,$,$,$,$);\n\
#3=IFCWALL('{b_hidden}',$,$,$,$,$,$,$,$);\n\
ENDSEC;\nEND-ISO-10303-21;\n"
    );

    let opts = MergedOptions {
        included: Some(vec![
            Some(VisibilityFilter { roots: vec![1, 2, 3, 6], excluded: vec![4] }),
            Some(VisibilityFilter { roots: vec![1, 2], excluded: vec![3] }),
        ]),
        ..MergedOptions::default()
    };
    let (merged, _stats) =
        export_merged_with_stats(&[model_a.as_bytes(), model_b.as_bytes()], &opts);

    // Included survive, exactly once each.
    for guid in [a_vis1, a_vis2, b_vis1] {
        assert_eq!(merged.matches(guid).count(), 1, "included GlobalId {guid} must survive");
    }
    // Excluded never appear -- neither model's exclusion leaks into the other.
    for guid in [a_hidden, b_hidden] {
        assert_eq!(merged.matches(guid).count(), 0, "excluded GlobalId {guid} must not be emitted");
    }
    // The relationship spanning the excluded wall must not be emitted at all
    // (dropped, not narrowed -- see merged_visibility.rs module doc), and
    // its pset (reachable only through it) must not survive as an orphan.
    assert!(!merged.contains("IFCRELDEFINESBYPROPERTIES"), "dangling relationship must be dropped");
    assert!(!merged.contains("pset-a"), "pset reachable only through the dropped relationship must not survive");

    // No dangling references anywhere in the output: every #ref resolves to
    // a written id. Reuses the same byte-level ref scan the GlobalId test
    // above uses, run over the FULL merged text.
    let written_ids: std::collections::HashSet<u32> = scan_ids(&merged).into_iter().collect();
    for line in merged.lines().filter(|l| l.starts_with('#')) {
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
                    assert!(written_ids.contains(&n), "dangling ref #{n} in visibility-filtered merge");
                    i = j;
                    continue;
                }
            }
            i += 1;
        }
    }
}

/// A SET/LIST relationship attribute naming three ids, only ONE of which is
/// excluded, must survive NARROWED to the two kept ids rather than being
/// dropped whole -- the defect this branch fixes. Distinct member count (3,
/// narrowed to 2) from `visibility_filter_excludes_per_model_and_drops_the_dangling_relationship`'s
/// 1-member-SET-emptied-to-0 case above, so neither could pass on the other's
/// fixture. Asserted against the exact EMITTED STEP text, not an intermediate
/// keep-set -- the shape of check this branch's own predecessor test lacked.
#[test]
fn narrows_a_set_relationship_to_its_surviving_members_not_the_whole_line() {
    let vis1 = "NNNNNNNNNNNNNNNNNNNNV1";
    let vis2 = "NNNNNNNNNNNNNNNNNNNNV2";
    let hidden = "NNNNNNNNNNNNNNNNNNNNHD";
    let content = format!(
        "ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION((''),'2;1');\nFILE_NAME('','',(''),(''),'','','');\nFILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\n\
#1=IFCPROJECT('proj',$,$,$,$,$,$,$,$);\n\
#2=IFCWALL('{vis1}',$,$,$,$,$,$,$,$);\n\
#3=IFCWALL('{vis2}',$,$,$,$,$,$,$,$);\n\
#4=IFCWALL('{hidden}',$,$,$,$,$,$,$,$);\n\
#5=IFCRELCONTAINEDINSPATIALSTRUCTURE('rel',$,$,$,(#2,#3,#4),#1);\n\
ENDSEC;\nEND-ISO-10303-21;\n"
    );

    let opts = MergedOptions {
        included: Some(vec![Some(VisibilityFilter { roots: vec![1, 2, 3, 5], excluded: vec![4] })]),
        ..MergedOptions::default()
    };
    let (merged, _stats) = export_merged_with_stats(&[content.as_bytes()], &opts);

    assert_eq!(merged.matches(vis1).count(), 1, "kept wall #1 survives");
    assert_eq!(merged.matches(vis2).count(), 1, "kept wall #2 survives");
    assert_eq!(merged.matches(hidden).count(), 0, "excluded wall never emitted");

    let rel_line = merged
        .lines()
        .find(|l| l.starts_with("#5="))
        .expect("the narrowed relationship must still be emitted, not dropped whole");
    assert_eq!(
        rel_line,
        "#5=IFCRELCONTAINEDINSPATIALSTRUCTURE('rel',$,$,$,(#2,#3),#1);",
        "SET narrowed to its two surviving members"
    );
}

/// An excluded id in a SINGLE-VALUED slot (no SET/LIST parentheses) has no
/// narrowing to fall back to -- the whole relationship must be withheld, same
/// as before this branch. Proves the two shapes stay distinguished: the SET
/// case just above survives narrowed, this one does not survive at all.
#[test]
fn drops_relationship_whole_when_excluded_id_is_in_a_single_valued_slot() {
    let wall = "SSSSSSSSSSSSSSSSSSSSW1";
    let opening = "SSSSSSSSSSSSSSSSSSSSOP";
    let content = format!(
        "ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION((''),'2;1');\nFILE_NAME('','',(''),(''),'','','');\nFILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\n\
#1=IFCPROJECT('proj',$,$,$,$,$,$,$,$);\n\
#2=IFCWALL('{wall}',$,$,$,$,$,$,$,$);\n\
#3=IFCOPENINGELEMENT('{opening}',$,$,$,$,$,$,$,$);\n\
#4=IFCRELVOIDSELEMENT('rel2',$,$,$,#2,#3);\n\
ENDSEC;\nEND-ISO-10303-21;\n"
    );

    let opts = MergedOptions {
        included: Some(vec![Some(VisibilityFilter { roots: vec![1, 2, 4], excluded: vec![3] })]),
        ..MergedOptions::default()
    };
    let (merged, _stats) = export_merged_with_stats(&[content.as_bytes()], &opts);

    assert_eq!(merged.matches(wall).count(), 1, "the wall itself still survives");
    assert_eq!(merged.matches(opening).count(), 0, "excluded opening never emitted");
    assert!(
        !merged.contains("IFCRELVOIDSELEMENT"),
        "a single-valued slot has no spelling for omitted -- withheld, not narrowed"
    );
}

/// A relationship naming no excluded ids at all must pass through the
/// visibility-filtered path byte-identical -- narrowing must be a strict
/// no-op when there is nothing to narrow.
#[test]
fn relationship_naming_no_excluded_ids_is_emitted_byte_identical() {
    let a = "UUUUUUUUUUUUUUUUUUUUA1";
    let b = "UUUUUUUUUUUUUUUUUUUUB1";
    let c = "UUUUUUUUUUUUUUUUUUUUC1";
    let original_rel_line = "#5=IFCRELCONTAINEDINSPATIALSTRUCTURE('rel',$,$,$,(#2,#3,#4),#1);";
    let content = format!(
        "ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION((''),'2;1');\nFILE_NAME('','',(''),(''),'','','');\nFILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\n\
#1=IFCPROJECT('proj',$,$,$,$,$,$,$,$);\n\
#2=IFCWALL('{a}',$,$,$,$,$,$,$,$);\n\
#3=IFCWALL('{b}',$,$,$,$,$,$,$,$);\n\
#4=IFCWALL('{c}',$,$,$,$,$,$,$,$);\n\
{original_rel_line}\n\
ENDSEC;\nEND-ISO-10303-21;\n"
    );

    let opts = MergedOptions {
        included: Some(vec![Some(VisibilityFilter { roots: vec![1, 2, 3, 4, 5], excluded: vec![] })]),
        ..MergedOptions::default()
    };
    let (merged, _stats) = export_merged_with_stats(&[content.as_bytes()], &opts);

    let rel_line = merged.lines().find(|l| l.starts_with("#5=")).expect("the relationship line");
    assert_eq!(rel_line, original_rel_line, "nothing excluded -- line must pass through byte-identical");
}

/// An ABSENT per-model filter entry (`included: Some(vec![None, ...])`, or
/// the whole `included` field left `None`) includes that model in full. An
/// explicitly EMPTY filter (`roots: vec![]`) on another model includes
/// NOTHING from it -- not even its `IfcProject`. These must be
/// distinguishable outcomes, not both collapsing to "everything" or both to
/// "nothing".
#[test]
fn empty_allowlist_means_nothing_absent_means_everything() {
    let model_a = "ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION((''),'2;1');\nFILE_NAME('','',(''),(''),'','','');\nFILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\n#1=IFCPROJECT('proja',$,$,$,$,$,$,$,$);\n#2=IFCWALL('AAAAAAAAAAAAAAAAAAAAWW',$,$,$,$,$,$,$,$);\nENDSEC;\nEND-ISO-10303-21;\n";
    let model_b = "ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION((''),'2;1');\nFILE_NAME('','',(''),(''),'','','');\nFILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\n#1=IFCPROJECT('projb',$,$,$,$,$,$,$,$);\n#2=IFCWALL('BBBBBBBBBBBBBBBBBBBBWW',$,$,$,$,$,$,$,$);\nENDSEC;\nEND-ISO-10303-21;\n";

    // Model A: explicitly empty allowlist -> nothing survives from it.
    // Model B: absent entry (None) -> included in full.
    let opts = MergedOptions {
        included: Some(vec![Some(VisibilityFilter::default()), None]),
        ..MergedOptions::default()
    };
    let (merged, stats) =
        export_merged_with_stats(&[model_a.as_bytes(), model_b.as_bytes()], &opts);

    assert!(!merged.contains("proja"), "empty allowlist must drop even model A's own IfcProject");
    assert!(!merged.contains("AAAAAAAAAAAAAAAAAAAAWW"), "empty allowlist keeps nothing from model A");
    assert!(merged.contains("projb"), "absent per-model entry keeps model B's IfcProject");
    assert!(merged.contains("BBBBBBBBBBBBBBBBBBBBWW"), "absent per-model entry keeps model B in full");
    assert_eq!(stats.written, 2, "exactly model B's 2 entities survive");

    // The whole-field-absent case (no filtering requested at all) is the
    // existing default behavior, already pinned by every other test in this
    // file that constructs `MergedOptions::default()` (included: None) and
    // asserts every source entity survives -- e.g.
    // `merge_two_models_unifies_project_and_offsets_ids` above.
}
/// The adversarial-review regression: a non-rooted entity carrying a 22-char
/// quoted string that coincidentally matches the GlobalId charset/length must
/// survive the merge byte-for-byte, even when it collides with ANOTHER
/// occurrence of the same string -- because it isn't a GlobalId at all, and
/// reconciling a coincidence corrupts ordinary model data.
///
/// Two independently-pinned layers, distinct group counts (3 vs 2) so
/// neither passes by coincidence:
///   - Layer (a), 3 `IFCMATERIALLAYER` entities: `Name` is that type's 4th
///     attribute, not its first. A scanner that finds the first quoted token
///     ANYWHERE on the line -- rather than the entity's true first attribute
///     -- misidentifies it as a GlobalId regardless of how complete a type
///     denylist is. Two of the three share the exact same 22-char `Name`
///     (the review's `'AAAAAAAAAAAAAAAAAAAAAA'` repro string) so the second
///     one hits the reconciliation path if the bug is present.
///   - Layer (b), 2 `IFCMATERIALLAYERSET` entities: here the coincidental
///     string genuinely IS the first attribute, so position alone can't
///     save it -- only recognising that `IfcMaterialLayerSet` is not an
///     `IfcRoot` subtype does. Both share the same string so the second
///     hits the reconciliation path if the type is wrongly treated as
///     rooted.
#[test]
fn merge_never_corrupts_a_non_rooted_string_that_looks_like_a_globalid() {
    let layer_dup = "AAAAAAAAAAAAAAAAAAAAAA"; // the review's exact repro string
    let layer_unique = "BBBBBBBBBBBBBBBBBBBBBB";
    let set_dup = "CCCCCCCCCCCCCCCCCCCCCC";

    let content = format!(
        "ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION((''),'2;1');\nFILE_NAME('','',(''),(''),'','','');\nFILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\n\
#1=IFCPROJECT('projx',$,$,$,$,$,$,$,$);\n\
#2=IFCMATERIALLAYER(#10,100.,.F.,'{layer_dup}',$,$,$,$);\n\
#3=IFCMATERIALLAYER(#10,150.,.F.,'{layer_unique}',$,$,$,$);\n\
#4=IFCMATERIALLAYER(#10,200.,.F.,'{layer_dup}',$,$,$,$);\n\
#5=IFCMATERIALLAYERSET('{set_dup}',$,$);\n\
#6=IFCMATERIALLAYERSET('{set_dup}',$,$);\n\
ENDSEC;\nEND-ISO-10303-21;\n"
    );

    let (merged, _stats) =
        export_merged_with_stats(&[content.as_bytes()], &MergedOptions::default());

    // Layer (a): all three IFCMATERIALLAYER lines, including the two that
    // coincidentally share the same Name, survive byte-for-byte.
    for line in [
        "#2=IFCMATERIALLAYER(#10,100.,.F.,'AAAAAAAAAAAAAAAAAAAAAA',$,$,$,$);",
        "#3=IFCMATERIALLAYER(#10,150.,.F.,'BBBBBBBBBBBBBBBBBBBBBB',$,$,$,$);",
        "#4=IFCMATERIALLAYER(#10,200.,.F.,'AAAAAAAAAAAAAAAAAAAAAA',$,$,$,$);",
    ] {
        assert!(
            merged.contains(line),
            "layer (a): a non-rooted entity's Name (not its first attribute) was corrupted -- missing line {line:?} in:\n{merged}"
        );
    }

    // Layer (b): both IFCMATERIALLAYERSET lines, sharing the same coincidental
    // first-attribute string, survive byte-for-byte too.
    for line in [
        "#5=IFCMATERIALLAYERSET('CCCCCCCCCCCCCCCCCCCCCC',$,$);",
        "#6=IFCMATERIALLAYERSET('CCCCCCCCCCCCCCCCCCCCCC',$,$);",
    ] {
        assert!(
            merged.contains(line),
            "layer (b): a non-rooted entity's first attribute was corrupted -- missing line {line:?} in:\n{merged}"
        );
    }
}

/// Isolates the positional half of the fix on its own: `IFCMATERIALLAYER`
/// above is filtered by the `IfcRoot` type check alone (it is never a
/// rooted type, so `leading_guid` returns early regardless of where the
/// quote sits) -- that test cannot by itself prove the position check does
/// anything. This one uses a genuinely rooted type (`IFCWALL`, which DOES
/// pass the type check) with a malformed/adversarial attribute list whose
/// first attribute is not a string at all, and whose Name (a later
/// attribute) happens to be GlobalId-shaped. Only the "quoted token must be
/// the first attribute" positional rule -- not the type check -- stops this
/// from being reconciled.
#[test]
fn merge_never_corrupts_a_rooted_entitys_non_leading_string_attribute() {
    let stray = "DDDDDDDDDDDDDDDDDDDDDD";
    let content = format!(
        "ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION((''),'2;1');\nFILE_NAME('','',(''),(''),'','','');\nFILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\n\
#1=IFCPROJECT('projy',$,$,$,$,$,$,$,$);\n\
#2=IFCWALL(#99,$,'{stray}',$,$,$,$,$,$);\n\
#3=IFCWALL(#99,$,'{stray}',$,$,$,$,$,$);\n\
ENDSEC;\nEND-ISO-10303-21;\n"
    );

    let (merged, _stats) =
        export_merged_with_stats(&[content.as_bytes()], &MergedOptions::default());

    for line in [
        "#2=IFCWALL(#99,$,'DDDDDDDDDDDDDDDDDDDDDD',$,$,$,$,$,$);",
        "#3=IFCWALL(#99,$,'DDDDDDDDDDDDDDDDDDDDDD',$,$,$,$,$,$);",
    ] {
        assert!(
            merged.contains(line),
            "a rooted type's non-leading string attribute was mistaken for its GlobalId -- missing line {line:?} in:\n{merged}"
        );
    }
}

/// `IfcDoorStyle` is a genuine `IfcRoot` subtype in IFC2X3 (its first
/// attribute IS the GlobalId) but the entity was dropped in IFC4X3, whose
/// entity table is the only one `rust/core`'s generated `IfcType` schema is
/// derived from. `IfcType::from_str("IFCDOORSTYLE")` therefore resolves to
/// `Unknown`, which is never a subtype of anything -- so an unpatched
/// `leading_guid` treats it as non-rooted and never reconciles its GlobalId.
/// Two IFC2X3 models sharing an `IFCDOORSTYLE` (a shared door-type/style
/// definition, the common "same catalog type in both files" case) must still
/// collapse to one occurrence in the merged output, exactly like the
/// IFC4 `IFCDOOR` case above.
#[test]
fn merge_reconciles_a_shared_globalid_on_an_ifc2x3_only_rooted_type() {
    let shared_style = "00000000000000000000D1";

    let model_a = format!(
        "ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION((''),'2;1');\nFILE_NAME('','',(''),(''),'','','');\nFILE_SCHEMA(('IFC2X3'));\nENDSEC;\nDATA;\n\
#1=IFCPROJECT('proja',$,$,$,$,$,$,$,$);\n\
#2=IFCDOORSTYLE('{shared_style}',$,$,$,$,$,$,$,$,$,$,$);\n\
ENDSEC;\nEND-ISO-10303-21;\n"
    );
    let model_b = format!(
        "ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION((''),'2;1');\nFILE_NAME('','',(''),(''),'','','');\nFILE_SCHEMA(('IFC2X3'));\nENDSEC;\nDATA;\n\
#1=IFCPROJECT('projb',$,$,$,$,$,$,$,$);\n\
#2=IFCDOORSTYLE('{shared_style}',$,$,$,$,$,$,$,$,$,$,$);\n\
ENDSEC;\nEND-ISO-10303-21;\n"
    );

    let (merged, _stats) =
        export_merged_with_stats(&[model_a.as_bytes(), model_b.as_bytes()], &MergedOptions::default());

    assert_eq!(
        merged.matches(shared_style).count(),
        1,
        "shared IFC2X3-only-rooted GlobalId {shared_style} must be emitted exactly once, not duplicated across federated models -- got:\n{merged}"
    );
}

// SPDX-License-Identifier: MPL-2.0
//! Tests for `merged.rs`, split out under the house pattern (AGENTS.md).
//!
//! Moved out so the production module stays under the module-size ratchet
//! (`rust/processing/tests/module_size_ratchet.rs`); this file is exempt via
//! the `_tests.rs` suffix convention.

use super::*;
use ifc_lite_core::EntityScanner;

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

    // Self-merge: every rooted entity of the second model shares a GlobalId with
    // the first (same unit space) and unifies into it — references remapped, the
    // line not re-emitted — matching merged-exporter.ts's reconciliation. So the
    // merged file has far fewer than 2*single lines, yet the first model survives
    // in full and the second still contributes its non-rooted geometry and
    // relationships (which carry no GlobalId to unify on).
    assert!(
        stats.written < single * 2 - 1,
        "duplicate rooted entities must unify, not blindly duplicate (written={}, single={single})",
        stats.written
    );
    assert!(
        stats.written > single,
        "second model's non-rooted geometry/relationships still contribute (written={}, single={single})",
        stats.written
    );

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
// module: `merged.rs` imports `escape` from `step_text.rs` and `detect_schema`
// from `schema_detect.rs` (the same primitives `step.rs` uses), so their unit coverage lives in `step_text_tests.rs` and `schema_detect_tests.rs`
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
        ..Default::default()
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
        ..Default::default()
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

/// `detect_schema` (now the shared `schema_detect::detect_schema`, imported
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

// ── Native feature-parity tests (issue #2951) ───────────────────────────────
//
// Synthetic federated scenes exercise the pieces the old id-offset-only merge
// lacked: GlobalId reconciliation, spatial unification, visibility filtering,
// and unit federation. All fixtures are inline STEP (no external fixtures).

/// A minimal but structurally complete IFC model: project + unit + site +
/// building + storey + wall + the full spatial aggregation chain
/// (project→site→building→storey) plus the wall's spatial containment. `tag`
/// makes every GlobalId unique per model (identical `tag` ⇒ identical
/// GlobalIds); `mm` selects millimetre vs metre length units;
/// `site_name`/`storey_name` drive spatial name-matching.
fn build_model(tag: &str, mm: bool, site_name: &str, storey_name: &str) -> String {
    let prefix = if mm { ".MILLI." } else { "$" };
    let g = |base: &str| -> String {
        let mut s = format!("{base}{tag}");
        while s.len() < 22 {
            s.push('0');
        }
        s.truncate(22);
        s
    };
    format!(
        "ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION((''),'2;1');\nFILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\n\
#1=IFCPROJECT('{proj}',$,'Project',$,$,$,$,$,#2);\n\
#2=IFCUNITASSIGNMENT((#3));\n\
#3=IFCSIUNIT(*,.LENGTHUNIT.,{prefix},.METRE.);\n\
#10=IFCSITE('{site}',$,'{site_name}',$,$,$,$,$,$);\n\
#11=IFCBUILDING('{bldg}',$,'Building',$,$,$,$,$,$,$,$);\n\
#12=IFCBUILDINGSTOREY('{storey}',$,'{storey_name}',$,$,$,$,$,.ELEMENT.,0.);\n\
#20=IFCWALL('{wall}',$,'Wall',$,$,$,$,$);\n\
#28=IFCRELAGGREGATES('{rprj}',$,$,$,#1,(#10));\n\
#29=IFCRELAGGREGATES('{rbld}',$,$,$,#11,(#12));\n\
#30=IFCRELAGGREGATES('{ragg}',$,$,$,#10,(#11));\n\
#31=IFCRELCONTAINEDINSPATIALSTRUCTURE('{rcon}',$,$,$,(#20),#12);\n\
ENDSEC;\nEND-ISO-10303-21;\n",
        proj = g("PROJ"),
        site = g("SITE"),
        bldg = g("BLDG"),
        storey = g("STOR"),
        wall = g("WALL"),
        rprj = g("RPRJ"),
        rbld = g("RBLD"),
        ragg = g("RAGG"),
        rcon = g("RCON"),
    )
}

/// The leading GlobalId of every ROOTED entity line in a STEP string, classified
/// by type (not just the 22-char shape), so a non-rooted entity leading with a
/// 22-char charset Name is never counted as a GlobalId (CR #2952).
fn leading_guids(step: &str) -> Vec<String> {
    step.lines()
        .filter(|l| l.starts_with('#'))
        .filter_map(|l| super::guid::leading_rooted_global_id(l.as_bytes()))
        .collect()
}

/// Count entity lines whose type token matches `=IFC…(`.
fn type_count(step: &str, needle: &str) -> usize {
    step.lines().filter(|l| l.contains(needle)).count()
}

/// Assert every `#ref` in the DATA section resolves to a written id.
fn assert_no_dangling(step: &str) {
    let ids: std::collections::HashSet<u32> = scan_ids(step).into_iter().collect();
    for line in step.lines().filter(|l| l.starts_with('#')) {
        let after_eq = line.find('=').map(|e| &line[e..]).unwrap_or(line);
        let bytes = after_eq.as_bytes();
        let mut i = 0;
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
                    assert!(ids.contains(&n), "dangling ref #{n} in {line:?}");
                    i = j;
                    continue;
                }
            }
            i += 1;
        }
    }
}

/// Every `#N` reference in a line's attribute list (after `=`), skipping the
/// leading express id and any `#` inside a quoted string. In source order.
fn refs_in_line(line: &str) -> Vec<u32> {
    let after_eq = line.find('=').map(|e| &line[e..]).unwrap_or(line);
    let bytes = after_eq.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
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
                out.push(n);
                i = j;
                continue;
            }
        }
        i += 1;
    }
    out
}

/// The express id of a `#123=…` line.
fn leading_id(line: &str) -> Option<u32> {
    line.strip_prefix('#')?.split('=').next()?.trim().parse().ok()
}

/// The express id of the single line whose text contains `needle` (panics unless
/// exactly one matches) — e.g. the sole surviving `=IFCSITE(` after a unify.
fn sole_id_of_type(step: &str, needle: &str) -> u32 {
    let ids: Vec<u32> =
        step.lines().filter(|l| l.contains(needle)).filter_map(leading_id).collect();
    assert_eq!(ids.len(), 1, "expected exactly one {needle}, found {ids:?}");
    ids[0]
}

#[test]
fn spatial_hierarchy_endpoints_remapped_after_merge() {
    // Two models with an identical named spatial tree unify into one
    // project→site→building→storey chain. The surviving aggregations must connect
    // the *single* unified containers, and both walls' containment must be
    // remapped onto the one storey — not left dangling (CR #2952).
    let a = build_model("A", true, "Terrain", "Level 1");
    let b = build_model("B", true, "Terrain", "Level 1");
    let (merged, _) =
        export_merged_with_stats(&[a.as_bytes(), b.as_bytes()], &MergedOptions::default());

    assert_no_dangling(&merged);
    let project = sole_id_of_type(&merged, "=IFCPROJECT(");
    let site = sole_id_of_type(&merged, "=IFCSITE(");
    let building = sole_id_of_type(&merged, "=IFCBUILDING(");
    let storey = sole_id_of_type(&merged, "=IFCBUILDINGSTOREY(");

    // The full aggregation chain survives, each hop pointing at the unified ids.
    let aggs: Vec<(u32, Vec<u32>)> = merged
        .lines()
        .filter(|l| l.contains("=IFCRELAGGREGATES("))
        .map(|l| {
            let r = refs_in_line(l);
            (r[0], r[1..].to_vec())
        })
        .collect();
    assert!(aggs.iter().any(|(rel, sub)| *rel == project && sub.as_slice() == [site]), "project→site");
    assert!(aggs.iter().any(|(rel, sub)| *rel == site && sub.as_slice() == [building]), "site→building");
    assert!(aggs.iter().any(|(rel, sub)| *rel == building && sub.as_slice() == [storey]), "building→storey");

    // Both walls' spatial containment (RelatingStructure is the last #ref) remaps
    // onto the one unified storey.
    let contain_storeys: Vec<u32> = merged
        .lines()
        .filter(|l| l.contains("=IFCRELCONTAINEDINSPATIALSTRUCTURE("))
        .map(|l| *refs_in_line(l).last().expect("a relating structure"))
        .collect();
    assert_eq!(contain_storeys.len(), 2, "both walls kept their containment");
    assert!(contain_storeys.iter().all(|&s| s == storey), "remapped onto the unified storey");
}

#[test]
fn within_model_duplicate_globalids_are_restamped() {
    // A single (first) model with two rooted entities carrying the SAME GlobalId
    // — a defective source. The cross-model map cannot see this (nothing is
    // registered until emit time), so reconciliation must track within-model
    // duplicates and re-stamp the second occurrence (CR #2952).
    let dup = "SAMEGUID00000000000000"; // 22 charset chars
    let model = format!(
        "ISO-10303-21;\nHEADER;\nFILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\n\
#1=IFCPROJECT('PROJ000000000000000000',$,$,$,$,$,$,$,$);\n\
#20=IFCWALL('{dup}',$,'Wall A',$,$,$,$,$);\n\
#21=IFCWALL('{dup}',$,'Wall B',$,$,$,$,$);\n\
ENDSEC;\nEND-ISO-10303-21;\n"
    );
    let (merged, _) = export_merged_with_stats(&[model.as_bytes()], &MergedOptions::default());

    // Both distinct walls survive, but no GlobalId is emitted twice.
    assert_eq!(type_count(&merged, "=IFCWALL("), 2, "both walls survive");
    let guids = leading_guids(&merged);
    let mut unique = guids.clone();
    unique.sort();
    unique.dedup();
    assert_eq!(unique.len(), guids.len(), "within-model duplicate GlobalId re-stamped");
    // Exactly one wall kept the original GlobalId; the other was minted fresh.
    assert_eq!(guids.iter().filter(|g| g.as_str() == dup).count(), 1);
    assert_no_dangling(&merged);
}

#[test]
fn assume_shared_reconciles_guids_across_incompatible_declared_units() {
    // Regression for the AssumeShared effective-scale (CR #2952): a later model
    // introduces a GlobalId under a declared unit incompatible with the first,
    // and a still-later model shares it. AssumeShared must unify the two — which
    // only holds if the introduced entity is recorded under the FIRST model's
    // scale, not its own. With the old `this_scale`, the third model's duplicate
    // would fail the units-compatible gate and be re-stamped instead of unified.
    let a = build_model("A", true, "Terrain", "Level 1"); // mm, primary
    let b = build_model("B", false, "Terrain", "Level 1"); // metre, distinct guids
    let c = build_model("B", false, "Terrain", "Level 1"); // metre, shares B's guids
    let opts = MergedOptions {
        unit_reconciliation: UnitReconciliation::AssumeShared,
        ..Default::default()
    };
    let (merged, stats) =
        export_merged_with_stats(&[a.as_bytes(), b.as_bytes(), c.as_bytes()], &opts);

    assert_eq!(stats.federated_model_count, 0, "AssumeShared never federates");
    // A's wall (WALLA…) plus the single unified B/C wall (WALLB…) = 2. If C's wall
    // were re-stamped rather than unified, there would be 3.
    assert_eq!(type_count(&merged, "=IFCWALL("), 2, "shared guid unified across the metre models");
    let guids = leading_guids(&merged);
    let mut unique = guids.clone();
    unique.sort();
    unique.dedup();
    assert_eq!(unique.len(), guids.len(), "no duplicate GlobalIds");
    assert_no_dangling(&merged);
}

#[test]
fn express_id_overflow_stops_merge_without_wrapping() {
    // A model whose max express id sits just below u32::MAX: a second model cannot
    // be placed without wrapping the cumulative offset, which would silently
    // duplicate ids and mis-point references. The merge must stop and report the
    // unmerged tail instead (CR #2952).
    let big = "ISO-10303-21;\nHEADER;\nFILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\n\
#4294967290=IFCWALL('WALLBIG0000000000000A',$,'W',$,$,$,$,$);\n\
ENDSEC;\nEND-ISO-10303-21;\n";
    let small = build_model("S", true, "Terrain", "Level 1");
    let (merged, stats) =
        export_merged_with_stats(&[big.as_bytes(), small.as_bytes()], &MergedOptions::default());

    assert_eq!(stats.unmerged_model_count, 1, "second model would overflow the id space");
    assert!(stats.warnings.iter().any(|w| w.contains("u32::MAX")), "overflow reported");
    // The first model still emitted validly — no wrapped ids, no dangling refs.
    assert_no_dangling(&merged);
    assert_eq!(type_count(&merged, "=IFCWALL("), 1, "only the first model's wall");
}

#[test]
fn excluded_high_id_does_not_block_a_fitting_later_model() {
    // The first model carries a near-max express id that visibility EXCLUDES, so
    // it is never emitted. The capacity bound must be the largest VISIBLE id, not
    // `index.max_id` — otherwise a later model that would comfortably fit is
    // wrongly omitted as an overflow (CR #2952).
    let big_excluded = "ISO-10303-21;\nHEADER;\nFILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\n\
#1=IFCWALL('WALLLOW00000000000000A',$,'Low',$,$,$,$,$);\n\
#4294967295=IFCWALL('WALLMAX00000000000000A',$,'Max',$,$,$,$,$);\n\
ENDSEC;\nEND-ISO-10303-21;\n";
    let second = build_model("S", true, "Terrain", "Level 1");
    let models = [
        // Only the low-id wall is visible; the max-id wall is excluded.
        MergedModel { content: big_excluded.as_bytes(), id: "a".to_string(), included: Some(vec![1]) },
        MergedModel { content: second.as_bytes(), id: "b".to_string(), included: None },
    ];
    let (merged, stats) = export_merged_models(&models, &MergedOptions::default());

    assert_eq!(stats.unmerged_model_count, 0, "the later model fits and must merge");
    assert!(stats.warnings.iter().all(|w| !w.contains("u32::MAX")), "no false overflow");
    // The first model's single visible wall plus the second model's wall.
    assert_eq!(type_count(&merged, "=IFCWALL("), 2);
    assert_eq!(type_count(&merged, "=IFCPROJECT("), 1, "second model's project survives");
    assert_no_dangling(&merged);
}

#[test]
fn converted_rooted_entity_keeps_source_globalid_for_later_unify() {
    // Two IFC4X3 models sharing one IfcAlignmentSegment (a rooted entity) GlobalId,
    // exported to IFC4 where the segment has no counterpart and is downgraded to a
    // proxy with a generated placeholder GlobalId. The first model must still
    // register the SOURCE GlobalId, so the second model's copy unifies with it
    // instead of emitting a second proxy (CR #2952).
    let shared = "0aBcDeFgHiJkLmNoPqRsT1"; // 22 charset chars
    let model = |proj: &str| {
        format!(
            "ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION((''),'2;1');\nFILE_SCHEMA(('IFC4X3'));\nENDSEC;\nDATA;\n\
#1=IFCPROJECT('{proj}',$,'P',$,$,$,$,$,$);\n\
#5=IFCALIGNMENTSEGMENT('{shared}',$,'Seg',$,$,$,$);\n\
ENDSEC;\nEND-ISO-10303-21;\n"
        )
    };
    let a = model("PROJA000000000000000AA");
    let b = model("PROJB000000000000000BB");
    let opts = MergedOptions { schema: Some("IFC4".to_string()), ..Default::default() };
    let (merged, _) = export_merged_with_stats(&[a.as_bytes(), b.as_bytes()], &opts);

    // The shared segment became exactly one proxy (the second unified with the
    // first), and no rooted GlobalId is emitted twice.
    assert_eq!(type_count(&merged, "=IFCPROXY("), 1, "shared converted entity unified, not duplicated");
    let guids = leading_guids(&merged);
    let mut unique = guids.clone();
    unique.sort();
    unique.dedup();
    assert_eq!(unique.len(), guids.len(), "no duplicate GlobalIds after conversion");
    assert_no_dangling(&merged);
}

#[test]
fn duplicate_globalids_are_reconciled_no_dupes() {
    // Two identical millimetre models. The old id-offset-only merge would emit
    // every GlobalId twice; reconciliation must unify same-unit roots and
    // re-stamp the objectified relationship instead.
    let m = build_model("A", true, "Terrain", "Level 1");
    let (merged, stats) =
        export_merged_with_stats(&[m.as_bytes(), m.as_bytes()], &MergedOptions::default());

    let guids = leading_guids(&merged);
    let mut unique = guids.clone();
    unique.sort();
    unique.dedup();
    assert_eq!(unique.len(), guids.len(), "no duplicate GlobalIds after merge");

    // One unified project, site, building, storey, wall.
    assert_eq!(type_count(&merged, "=IFCPROJECT("), 1);
    assert_eq!(type_count(&merged, "=IFCSITE("), 1);
    assert_eq!(type_count(&merged, "=IFCBUILDINGSTOREY("), 1);
    assert_eq!(type_count(&merged, "=IFCWALL("), 1, "duplicate wall unified");
    // The objectified relationship is re-stamped (kept), not dropped.
    assert_eq!(type_count(&merged, "=IFCRELCONTAINEDINSPATIALSTRUCTURE("), 2);
    assert_eq!(stats.federated_model_count, 0);
    assert!(!stats.unit_rescale_required);
    assert_no_dangling(&merged);
}

#[test]
fn spatial_containers_unify_by_name() {
    // Distinct element GlobalIds, but identical site/storey names ⇒ one shared
    // spatial tree.
    let a = build_model("A", true, "Terrain", "Level 1");
    let b = build_model("B", true, "Terrain", "Level 1");
    let (merged, stats) =
        export_merged_with_stats(&[a.as_bytes(), b.as_bytes()], &MergedOptions::default());

    assert_eq!(type_count(&merged, "=IFCSITE("), 1, "sites unified by name");
    assert_eq!(type_count(&merged, "=IFCBUILDING("), 1, "buildings unified");
    assert_eq!(type_count(&merged, "=IFCBUILDINGSTOREY("), 1, "storeys unified by name");
    // Two distinct walls survive (different GlobalIds, both physical elements).
    assert_eq!(type_count(&merged, "=IFCWALL("), 2);
    assert_eq!(type_count(&merged, "=IFCPROJECT("), 1);
    assert_eq!(stats.federated_model_count, 0);
    assert_no_dangling(&merged);
}

#[test]
fn distinct_storey_names_stay_separate() {
    // Same site, different storey names, ByName strategy (no elevation fallback)
    // ⇒ storeys are NOT merged.
    let a = build_model("A", true, "Terrain", "Level 1");
    let b = build_model("B", true, "Terrain", "Level 2");
    let opts =
        MergedOptions { merge_storeys: StoreyMergeStrategy::ByName, ..Default::default() };
    let (merged, _stats) = export_merged_with_stats(&[a.as_bytes(), b.as_bytes()], &opts);
    assert_eq!(type_count(&merged, "=IFCSITE("), 1, "sites still unify");
    assert_eq!(type_count(&merged, "=IFCBUILDINGSTOREY("), 2, "differently-named storeys kept");
    assert_no_dangling(&merged);
}

#[test]
fn visibility_allowlist_limits_output() {
    // Include only the wall (express id 20). Its forward closure is just itself
    // (all its attributes are `$`), so nothing else is emitted.
    let a = build_model("A", true, "Terrain", "Level 1");
    let models =
        [MergedModel { content: a.as_bytes(), id: "a".to_string(), included: Some(vec![20]) }];
    let (merged, _stats) = export_merged_models(&models, &MergedOptions::default());

    assert_eq!(type_count(&merged, "=IFCWALL("), 1);
    assert_eq!(type_count(&merged, "=IFCPROJECT("), 0, "project excluded by visibility");
    assert_eq!(type_count(&merged, "=IFCSITE("), 0, "site excluded by visibility");
    assert_no_dangling(&merged);
}

#[test]
fn first_model_visibility_excluded_target_does_not_dangle() {
    // The first model exports only its wall (id 20) — its IfcProject / unit /
    // site / building / storey are excluded by visibility. A later compatible
    // model must NOT redirect its references onto those non-emitted canonical
    // ids, which would dangle (Greptile P1 / CR #2952). It keeps its own instead.
    let a = build_model("A", true, "Terrain", "Level 1");
    let b = build_model("B", true, "Terrain", "Level 1");
    let models = [
        MergedModel { content: a.as_bytes(), id: "a".to_string(), included: Some(vec![20]) },
        MergedModel { content: b.as_bytes(), id: "b".to_string(), included: None },
    ];
    let (merged, _stats) = export_merged_models(&models, &MergedOptions::default());

    // No reference points at an entity the first model's visibility dropped.
    assert_no_dangling(&merged);
    // The second model kept its own project (it could not unify into an excluded
    // one), and both walls survive.
    assert_eq!(type_count(&merged, "=IFCPROJECT("), 1, "second model keeps its project");
    assert_eq!(type_count(&merged, "=IFCWALL("), 2);
    // Still no duplicate GlobalIds after the fallback.
    let guids = leading_guids(&merged);
    let mut unique = guids.clone();
    unique.sort();
    unique.dedup();
    assert_eq!(unique.len(), guids.len());
}

#[test]
fn incompatible_units_federate_and_flag_under_normalize() {
    // Millimetre + metre models. Under Normalize the metre model cannot be
    // rescaled natively, so it is federated and the flag is set for the caller.
    let mm = build_model("A", true, "Terrain", "Level 1");
    let m = build_model("B", false, "Terrain", "Level 1");
    let opts =
        MergedOptions { unit_reconciliation: UnitReconciliation::Normalize, ..Default::default() };
    let (merged, stats) = export_merged_with_stats(&[mm.as_bytes(), m.as_bytes()], &opts);

    assert_eq!(type_count(&merged, "=IFCPROJECT("), 2, "incompatible model federated");
    // Federation keeps the metre model wholly separate: none of its spatial
    // containers or elements are unified into the millimetre model's.
    assert_eq!(type_count(&merged, "=IFCSITE("), 2, "federated site kept separate");
    assert_eq!(type_count(&merged, "=IFCBUILDING("), 2, "federated building kept separate");
    assert_eq!(type_count(&merged, "=IFCBUILDINGSTOREY("), 2, "federated storey kept separate");
    assert_eq!(type_count(&merged, "=IFCWALL("), 2, "federated wall kept separate");
    assert_eq!(stats.federated_model_count, 1);
    assert!(stats.unit_rescale_required, "caller should gate to the JS path");
    assert!(!stats.warnings.is_empty());
    let guids = leading_guids(&merged);
    let mut unique = guids.clone();
    unique.sort();
    unique.dedup();
    assert_eq!(unique.len(), guids.len());
    assert_no_dangling(&merged);
}

#[test]
fn assume_shared_unifies_across_declared_units() {
    // Same GlobalIds, different declared units. AssumeShared skips the
    // compatibility check and unifies into one project regardless.
    let mm = build_model("A", true, "Terrain", "Level 1");
    let m = build_model("A", false, "Terrain", "Level 1");
    let opts = MergedOptions {
        unit_reconciliation: UnitReconciliation::AssumeShared,
        ..Default::default()
    };
    let (merged, stats) = export_merged_with_stats(&[mm.as_bytes(), m.as_bytes()], &opts);

    assert_eq!(type_count(&merged, "=IFCPROJECT("), 1, "unified despite unit mismatch");
    // Identical GlobalIds + names across the two models: every matching rooted
    // entity unifies into exactly one instance despite the declared-unit mismatch.
    assert_eq!(type_count(&merged, "=IFCSITE("), 1, "site unified");
    assert_eq!(type_count(&merged, "=IFCBUILDING("), 1, "building unified");
    assert_eq!(type_count(&merged, "=IFCBUILDINGSTOREY("), 1, "storey unified");
    assert_eq!(type_count(&merged, "=IFCWALL("), 1, "wall unified");
    // And no duplicate rooted GlobalIds survive.
    let guids = leading_guids(&merged);
    let mut unique = guids.clone();
    unique.sort();
    unique.dedup();
    assert_eq!(unique.len(), guids.len(), "unique rooted GlobalIds after AssumeShared unify");
    assert_eq!(stats.federated_model_count, 0);
    assert!(!stats.unit_rescale_required);
    assert_no_dangling(&merged);
}

// ── GlobalId reconciliation regression tests (issue #3007) ───────────────────
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

/// `IfcElectricalCircuit` is a rooted IFC2X3 type (parent chain `IfcSystem` →
/// `IfcGroup` → … → `IfcRoot`, leading with a GlobalId) that was dropped from
/// IFC4X3 AND is absent from `legacy_entities.rs`, so it resolves to
/// `IfcType::Unknown` and the schema check alone classifies it as non-rooted.
/// This is exactly the 38-type gap #2952 measured: without the legacy rooted
/// fallback its shared GlobalId would duplicate across models. Unlike the
/// `IFCDOORSTYLE` case above (which maps to `IfcDoorType` via `legacy_entities`
/// and passes through the schema path), this one only passes through the
/// fallback, so it pins the fallback end to end.
#[test]
fn merge_reconciles_a_shared_globalid_on_a_legacy_rooted_type_absent_from_schema() {
    let shared = "00000000000000000000E1";
    let model = |proj: &str| {
        format!(
            "ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION((''),'2;1');\nFILE_NAME('','',(''),(''),'','','');\nFILE_SCHEMA(('IFC2X3'));\nENDSEC;\nDATA;\n\
#1=IFCPROJECT('{proj}',$,$,$,$,$,$,$,$);\n\
#2=IFCELECTRICALCIRCUIT('{shared}',$,'Circuit',$,$,$,$);\n\
ENDSEC;\nEND-ISO-10303-21;\n"
        )
    };
    let a = model("proja0");
    let b = model("projb0");
    let (merged, _stats) =
        export_merged_with_stats(&[a.as_bytes(), b.as_bytes()], &MergedOptions::default());

    assert_eq!(
        merged.matches(shared).count(),
        1,
        "shared legacy-rooted GlobalId {shared} must be emitted exactly once -- got:\n{merged}"
    );
    // The circuit itself is unified (not a relationship type), so exactly one survives.
    assert_eq!(type_count(&merged, "=IFCELECTRICALCIRCUIT("), 1);
    assert_no_dangling(&merged);
}

/// Every two-model fixture elsewhere gives both models an `IfcProject` at the
/// SAME express id (`#1`, or literally the same file twice) -- so
/// `canonical_project` and the current model's own project id are always equal,
/// and the redirect that unifies the project cannot be observed to pick the
/// FIRST model's id over the current model's (the #3083 blind spot).
///
/// Here the two projects sit at DIFFERENT express ids (`#1` in model A, `#7` in
/// model B), and model B's kept `IfcRelAggregates` relates its project to a
/// DISTINCT wall -- so our redundant-aggregation pruning keeps it (only fully
/// unified aggregations are dropped, #2952) and its relating reference stays
/// observable. That reference must land on model A's project, not on B's own
/// `#7` (unified away) nor its offset image.
///
/// NB #3083's original fixture related the project to ITSELF (`#7,(#7)`); after
/// unification both endpoints point at the unified project, so pruning correctly
/// drops that degenerate row -- which reads as the redirect "disappearing". The
/// distinct related wall below keeps the redirect visible.
#[test]
fn later_models_project_ref_redirects_to_the_first_models_project() {
    let model_a = "ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION((''),'2;1');\nFILE_NAME('','',(''),(''),'','','');\nFILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\n\
#1=IFCPROJECT('11111111111111111111P1',$,'ProjectA',$,$,$,$,$,$);\n\
#2=IFCWALL('11111111111111111111W1',$,'WallA',$,$,$,$,$);\n\
#3=IFCRELAGGREGATES('11111111111111111111R1',$,$,$,#1,(#2));\n\
ENDSEC;\nEND-ISO-10303-21;\n";
    let model_b = "ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION((''),'2;1');\nFILE_NAME('','',(''),(''),'','','');\nFILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\n\
#7=IFCPROJECT('22222222222222222222P2',$,'ProjectB',$,$,$,$,$,$);\n\
#8=IFCWALL('22222222222222222222W2',$,'WallB',$,$,$,$,$);\n\
#9=IFCRELAGGREGATES('22222222222222222222R2',$,$,$,#7,(#8));\n\
ENDSEC;\nEND-ISO-10303-21;\n";

    let (merged, _stats) = export_merged_with_stats(
        &[model_a.as_bytes(), model_b.as_bytes()],
        &MergedOptions::default(),
    );

    assert_no_dangling(&merged);
    // Exactly one project survives -- model A's, at its own id (offset 0).
    let project = sole_id_of_type(&merged, "=IFCPROJECT(");
    let project_line = merged.lines().find(|l| l.contains("=IFCPROJECT(")).unwrap();
    assert!(project_line.contains("'ProjectA'"), "surviving project is model A's: {project_line:?}");
    assert!(!merged.contains("22222222222222222222P2"), "model B's project is unified away:\n{merged}");

    // Model B's kept aggregation now relates the UNIFIED project (model A's id),
    // NOT B's own #7 nor its offset image.
    let b_rel = merged
        .lines()
        .find(|l| l.contains("'22222222222222222222R2'"))
        .expect("model B's IfcRelAggregates survives (its related wall is not unified)");
    let refs = refs_in_line(b_rel);
    assert_eq!(refs[0], project, "B's project ref redirected to model A's project: {b_rel:?}");
    // Model A's own aggregation is untouched (offset 0, no redirect needed).
    assert!(
        merged.contains("#3=IFCRELAGGREGATES('11111111111111111111R1',$,$,$,#1,(#2));"),
        "model A's aggregation is unchanged:\n{merged}"
    );
}

/// Collect the leading 22-char GlobalId-shaped token of every DATA-section
/// entity line, i.e. exactly what `leading_guid` reads.
fn leading_guid_tokens(step: &str) -> Vec<String> {
    step.lines()
        .filter(|l| l.starts_with('#'))
        .filter_map(|l| {
            let open = l.find('(')?;
            let rest = &l[open + 1..];
            let body = rest.strip_prefix('\'')?;
            let q2 = body.find('\'')?;
            let tok = &body[..q2];
            super::guid::is_global_id(tok).then(|| tok.to_string())
        })
        .collect()
}

/// A model carrying the SAME GlobalId on THREE rooted entities is an authoring
/// defect the merge must not carry through as duplicates (the #3083 concern:
/// the same-seed mint guards keeping fresh ids apart). Under our reconciliation
/// the first cross-model occurrence UNIFIES with model A's entity (same unit
/// space), and the two remaining within-model duplicates are each re-stamped
/// with a distinct fresh GlobalId -- so no GlobalId is ever emitted twice.
/// The assertion is on the emitted STEP text (every leading GlobalId distinct),
/// not on an intermediate map.
#[test]
fn merge_mints_distinct_ids_for_collisions_within_the_same_model() {
    let shared = "00000000000000000000E1";
    let model_a = format!(
        "ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION((''),'2;1');\nFILE_NAME('','',(''),(''),'','','');\nFILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\n\
#1=IFCPROJECT('11111111111111111111PA',$,$,$,$,$,$,$,$);\n\
#2=IFCDOOR('{shared}',$,$,$,$,$,$,$,$);\n\
ENDSEC;\nEND-ISO-10303-21;\n"
    );
    // Model B carries the SAME GlobalId on THREE entities: all three collide
    // with model A's already-emitted one, and all three seed identically.
    let model_b = format!(
        "ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION((''),'2;1');\nFILE_NAME('','',(''),(''),'','','');\nFILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\n\
#1=IFCPROJECT('22222222222222222222PB',$,$,$,$,$,$,$,$);\n\
#2=IFCDOOR('{shared}',$,$,$,$,$,$,$,$);\n\
#3=IFCDOOR('{shared}',$,$,$,$,$,$,$,$);\n\
#4=IFCDOOR('{shared}',$,$,$,$,$,$,$,$);\n\
ENDSEC;\nEND-ISO-10303-21;\n"
    );

    let (merged, _stats) = export_merged_with_stats(
        &[model_a.as_bytes(), model_b.as_bytes()],
        &MergedOptions::default(),
    );

    // Every emitted GlobalId is distinct: same-model collisions minting the same
    // replacement would just relocate the duplicate rather than remove it.
    let tokens = leading_guid_tokens(&merged);
    let unique: std::collections::HashSet<&String> = tokens.iter().collect();
    assert_eq!(
        unique.len(),
        tokens.len(),
        "every emitted GlobalId must be distinct: {tokens:?}"
    );

    // The shared GlobalId survives on exactly one entity (model A's door, which
    // B's first door unified into); the other two B doors were re-stamped fresh.
    assert_eq!(
        tokens.iter().filter(|t| *t == shared).count(),
        1,
        "the colliding GlobalId survives on exactly one entity: {tokens:?}"
    );
    // Model A's door plus B's two re-stamped doors: three distinct doors survive.
    assert_eq!(type_count(&merged, "=IFCDOOR("), 3, "one unified door + two re-stamped");
    assert_no_dangling(&merged);
}

/// The user-visible half of the #3124 review's major finding, through the
/// public `export_merged`: reconciliation must not depend on which name the
/// IFC4X3 generated enum happens to model.
///
/// `IFCSOLIDSTRATUM` is a real IFC4.3 entity that authoring tools emit for
/// terrain and soil layers, and it is rooted -- but the generated enum
/// carries only its abstract base `IfcGeotechnicalStratum`, so a bare
/// `IfcType::from_str` said `Unknown` and the merge skipped it. Two
/// infrastructure models sharing a stratum then merged to a file with the
/// same GlobalId twice, an IFC spec violation, while the `IFCWALL` on the
/// very next line was reconciled correctly. The asymmetry is the assertion:
/// both types are checked in one merge, so a fix that reconciled nothing at
/// all could not pass either.
#[test]
fn merge_reconciles_a_shared_globalid_on_a_stratum_leaf_as_it_does_on_a_wall() {
    let shared_stratum = "1SharedGuid0000000000A";
    let shared_wall = "1SharedGuid0000000000B";

    let model = |project: &str| {
        format!(
            "ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION((''),'2;1');\nFILE_NAME('','',(''),(''),'','','');\nFILE_SCHEMA(('IFC4X3'));\nENDSEC;\nDATA;\n\
#1=IFCPROJECT('{project}',$,$,$,$,$,$,$,$);\n\
#2=IFCSOLIDSTRATUM('{shared_stratum}',$,$,$,$,$,$,.SOLID.);\n\
#3=IFCWALL('{shared_wall}',$,$,$,$,$,$,$,$);\n\
ENDSEC;\nEND-ISO-10303-21;\n"
        )
    };
    let model_a = model("proja");
    let model_b = model("projb");

    let merged = export_merged(
        &[model_a.as_bytes(), model_b.as_bytes()],
        &MergedOptions::default(),
    );

    assert_eq!(
        merged.matches(shared_wall).count(),
        1,
        "control: a shared GlobalId on IFCWALL is reconciled to one occurrence"
    );
    assert_eq!(
        merged.matches(shared_stratum).count(),
        1,
        "a shared GlobalId on IFCSOLIDSTRATUM must be reconciled the same way -- \
         a second occurrence is the duplicate this step exists to prevent"
    );
    // Reconciled identically to the wall: a shared GlobalId on a compatible
    // model's non-relationship rooted entity is unified — the duplicate line is
    // dropped and its references redirected to the first model's entity — so the
    // stratum collapses to exactly one occurrence, just as the wall does. The
    // point of the test is the symmetry (stratum classified and reconciled like
    // the wall), not the drop-vs-restamp policy.
    assert_eq!(
        merged.matches("=IFCSOLIDSTRATUM(").count(),
        1,
        "the shared stratum is unified to a single surviving entity, like the wall"
    );
    assert_eq!(
        merged.matches("=IFCWALL(").count(),
        1,
        "control: the shared wall is likewise unified to a single surviving entity"
    );
}

/// A federation whose spatial trees unify: model A carries the whole
/// project→site→building→two-storey tree with a wall on Level 0, model B repeats
/// the tree (matched by name) and adds nothing to Level 1.
fn two_models_with_an_empty_storey() -> (String, String) {
    let head = "ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION((''),'2;1');\nFILE_NAME('','',(''),(''),'','','');\nFILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\n";
    let tail = "ENDSEC;\nEND-ISO-10303-21;\n";
    let tree = |salt: &str, wall: &str| {
        format!(
            "{head}\
#1=IFCPROJECT('p{salt}',$,'P',$,$,$,$,$,$);\n\
#2=IFCSITE('s{salt}',$,'Site',$,$,$,$,$,$,$,$,$,$,$);\n\
#3=IFCBUILDING('b{salt}',$,'Building',$,$,$,$,$,$,$,$,$);\n\
#4=IFCBUILDINGSTOREY('g{salt}',$,'Level 0',$,$,$,$,$,$,0.);\n\
#5=IFCBUILDINGSTOREY('f{salt}',$,'Level 1',$,$,$,$,$,$,3.);\n\
#6=IFCWALL('{wall}',$,'Wall',$,$,$,$,$,$);\n\
#7=IFCRELAGGREGATES('a{salt}',$,$,$,#1,(#2));\n\
#8=IFCRELAGGREGATES('c{salt}',$,$,$,#2,(#3));\n\
#9=IFCRELAGGREGATES('d{salt}',$,$,$,#3,(#4,#5));\n\
#10=IFCRELCONTAINEDINSPATIALSTRUCTURE('e{salt}',$,$,$,(#6),#4);\n\
{tail}"
        )
    };
    (tree("0", "wall000000000000000000"), tree("1", "wall111111111111111111"))
}

/// #3643: the "Merge Projects" recipe step container matching leaves behind —
/// a storey no model puts anything in is not written at all, and the merge
/// emits nothing referencing it, so no clean-up pass has to follow.
#[test]
fn empty_container_is_dropped_and_leaves_no_dangling_reference() {
    let (a, b) = two_models_with_an_empty_storey();
    let opts = MergedOptions { drop_empty_containers: true, ..Default::default() };
    let (merged, stats) = export_merged_with_stats(&[a.as_bytes(), b.as_bytes()], &opts);

    // Level 1 is empty in BOTH models, so the one unified storey goes.
    assert_eq!(stats.dropped_container_count, 1, "one merged container dropped");
    assert_eq!(type_count(&merged, "'Level 1'"), 0, "the empty storey is not written");
    assert_eq!(type_count(&merged, "'Level 0'"), 1, "the populated storey survives");
    assert_eq!(type_count(&merged, "=IFCSITE("), 1, "its site is kept — it holds a storey");
    assert_eq!(type_count(&merged, "=IFCBUILDING("), 1, "so is its building");
    assert_eq!(type_count(&merged, "=IFCWALL("), 2, "no element is lost");

    // The aggregation that named it is rewritten without it, not left dangling.
    let storey = sole_id_of_type(&merged, "'Level 0'");
    let aggregates: Vec<&str> =
        merged.lines().filter(|l| l.contains("=IFCRELAGGREGATES(")).collect();
    assert!(
        aggregates.iter().any(|l| refs_in_line(l).contains(&storey)),
        "the surviving storey keeps its parent aggregation: {aggregates:?}"
    );
    assert_no_dangling(&merged);
}

/// The flag is off by default and changes nothing when there is nothing to drop:
/// asking for the drop on a model whose every container is populated must return
/// byte-identical output, so enabling it can never perturb an unrelated merge.
#[test]
fn dropping_is_off_by_default_and_inert_when_nothing_is_empty() {
    let (a, b) = two_models_with_an_empty_storey();
    // Give Level 1 an occupant in model B, so no container is empty any more.
    let b = b.replace(
        "#10=IFCRELCONTAINEDINSPATIALSTRUCTURE('e1',$,$,$,(#6),#4);",
        "#10=IFCRELCONTAINEDINSPATIALSTRUCTURE('e1',$,$,$,(#6),#5);",
    );
    let models = [a.as_bytes(), b.as_bytes()];

    let (baseline, base_stats) = export_merged_with_stats(&models, &MergedOptions::default());
    assert_eq!(base_stats.dropped_container_count, 0, "default drops nothing");

    let opts = MergedOptions { drop_empty_containers: true, ..Default::default() };
    let (dropped, stats) = export_merged_with_stats(&models, &opts);
    assert_eq!(stats.dropped_container_count, 0, "every container holds something");
    assert_eq!(dropped, baseline, "output is byte-identical when nothing is empty");
}

/// The drop plan must cover only the models the merge actually EMITS. A model
/// past the EXPRESS-id cut is never written, so treating its content as present
/// would keep a container nothing in the output fills — and report it as
/// surviving. Found in review of #3643.
#[test]
fn a_model_past_the_id_space_cut_does_not_keep_a_container_alive() {
    // The first model's near-max id leaves no room for the second, so the merge
    // stops after model A. A's storey is empty; only the unmerged B fills it.
    let a = "ISO-10303-21;\nHEADER;\nFILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\n\
#4294967295=IFCBUILDINGSTOREY('STOREYA000000000000001',$,'Level 0',$,$,$,$,$,$,0.);\n\
ENDSEC;\nEND-ISO-10303-21;\n";
    let b = "ISO-10303-21;\nHEADER;\nFILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\n\
#1=IFCBUILDINGSTOREY('STOREYB000000000000001',$,'Level 0',$,$,$,$,$,$,0.);\n\
#2=IFCWALL('WALLB00000000000000001',$,'Wall',$,$,$,$,$,$);\n\
#3=IFCRELCONTAINEDINSPATIALSTRUCTURE('RELB000000000000000001',$,$,$,(#2),#1);\n\
ENDSEC;\nEND-ISO-10303-21;\n";
    let opts = MergedOptions { drop_empty_containers: true, ..Default::default() };
    let (merged, stats) = export_merged_with_stats(&[a.as_bytes(), b.as_bytes()], &opts);

    assert_eq!(stats.unmerged_model_count, 1, "the second model cannot be placed");
    // Model B's wall is never emitted, so the storey it would have filled is
    // genuinely empty in the OUTPUT and must go.
    assert_eq!(stats.dropped_container_count, 1, "the storey no emitted model fills is dropped");
    assert_eq!(type_count(&merged, "=IFCBUILDINGSTOREY("), 0, "and is not written");
    assert_no_dangling(&merged);
}

/// A real authoring-tool model, self-merged with the flag on: the drop must not
/// remove anything a model actually uses, and must not dangle a reference.
#[test]
fn dropping_containers_keeps_a_real_model_intact() {
    let bytes = fixture_or_skip!("ara3d/duplex.ifc");
    let models = [bytes.as_slice(), bytes.as_slice()];
    let baseline = export_merged(&models, &MergedOptions::default());
    let opts = MergedOptions { drop_empty_containers: true, ..Default::default() };
    let (merged, stats) = export_merged_with_stats(&models, &opts);

    assert_no_dangling(&merged);
    assert_eq!(
        type_count(&merged, "=IFCWALL("),
        type_count(&baseline, "=IFCWALL("),
        "no element is lost to the container drop"
    );
    let containers = |step: &str| {
        ["=IFCSITE(", "=IFCBUILDING(", "=IFCBUILDINGSTOREY(", "=IFCSPACE("]
            .iter()
            .map(|needle| type_count(step, needle))
            .sum::<usize>()
    };
    assert_eq!(
        containers(&merged),
        containers(&baseline) - stats.dropped_container_count,
        "the containers that disappear are exactly the ones counted as dropped"
    );
}


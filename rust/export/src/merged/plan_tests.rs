// SPDX-License-Identifier: MPL-2.0
//! Tests for `plan.rs`, split out under the house pattern (AGENTS.md).
//!
//! Moved out so the production module stays under the module-size ratchet
//! (`rust/processing/tests/module_size_ratchet.rs`); this file is exempt via
//! the `_tests.rs` suffix convention.

use super::*;

const TWO_STOREYS: &str = "ISO-10303-21;\nHEADER;\nFILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\n#1=IFCPROJECT('p',$,$,$,$,$,$,$,$);\n#2=IFCSITE('s',$,'Site',$,$,$,$,$,$);\n#3=IFCRELAGGREGATES('r',$,$,$,#1,(#2));\nENDSEC;\nEND-ISO-10303-21;\n";

#[test]
fn build_indexes_order_types_and_max() {
    let idx = ModelIndex::build(TWO_STOREYS.as_bytes());
    assert_eq!(idx.order, vec![1, 2, 3]);
    assert_eq!(idx.projects, vec![1]);
    assert_eq!(idx.site_count, 1);
    assert_eq!(idx.type_of.get(&2).map(String::as_str), Some("IFCSITE"));
}

/// EXPORT-MERGE-18 (#7683): with a repeated express id the index kept the
/// LAST record's text but the FIRST record's type and place, so the wall below
/// was classified as an owner history. One record wins whole, the last one,
/// as in core and both STEP writers (`step_index::RecordIndex`), and the
/// earlier one is listed for the merge to report. The losing record's type
/// feeds none of the per-type facts either.
#[test]
fn a_repeated_id_keeps_the_last_record_whole_as_core_does_7683() {
    let content = b"ISO-10303-21;\nHEADER;\nFILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\n#5=IFCOWNERHISTORY(#1,#2,$,.ADDED.,$,$,$,0);\n#1=IFCPROJECT('p',$,$,$,$,$,$,$,$);\n#2=IFCPROJECT('q',$,$,$,$,$,$,$,$);\n#5=IFCWALL('w',$,$,$,$,$,$,$,$);\n#2=IFCSITE('s',$,'Site',$,$,$,$,$,$);\nENDSEC;\nEND-ISO-10303-21;\n";
    let idx = ModelIndex::build(content);
    assert_eq!(idx.order, vec![1, 5, 2], "each id once, at its last record");
    assert_eq!(idx.type_of.get(&5).map(String::as_str), Some("IFCWALL"));
    assert!(idx.line_str(5).is_some_and(|l| l.starts_with("#5=IFCWALL(")));
    assert_eq!(idx.projects, vec![1], "#2's losing IFCPROJECT record is not a project");
    assert_eq!(idx.site_count, 1);
    let core = ifc_lite_core::build_entity_index(content);
    let (s, _) = core[&5];
    assert!(content[s..].starts_with(b"#5=IFCWALL("), "the record core resolves #5 to");

    let (out, stats) = crate::export_merged_with_stats(&[content], &crate::MergedOptions::default());
    assert!(!out.contains("IFCOWNERHISTORY"), "the losing record is not written:\n{out}");
    assert_eq!(stats.warnings.iter().filter(|w| w.contains("appears more than once")).count(), 2, "{:?}", stats.warnings);
}

#[test]
fn resolve_included_pulls_forward_closure() {
    let idx = ModelIndex::build(TWO_STOREYS.as_bytes());
    // Root at the rel: closure must pull in #1 (relating) and #2 (related).
    let mut refused = 0usize;
    let included = resolve_included(&idx, &Some(vec![3]), Some(&mut refused));
    assert!(included.contains(&3) && included.contains(&1) && included.contains(&2));
    assert_eq!(refused, 0, "no reference in this fixture exceeds u32::MAX");
    // None → everything.
    assert_eq!(resolve_included(&idx, &None, Some(&mut refused)).len(), 3);
}

/// RED for issue #3752: a filtered model whose root references an oversized
/// id must count the refusal, not just silently exclude the closure it
/// would have pulled in (issue #3421 governs the exclusion itself).
#[test]
fn resolve_included_counts_a_refused_oversized_reference() {
    let content = b"ISO-10303-21;\nHEADER;\nFILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\n#1=IFCWALL('g',$,$,$,$,#4294967297,$,$,$);\nENDSEC;\nEND-ISO-10303-21;\n";
    let idx = ModelIndex::build(content);
    let mut refused = 0usize;
    let included = resolve_included(&idx, &Some(vec![1]), Some(&mut refused));
    assert!(included.contains(&1));
    assert_eq!(refused, 1, "the oversized reference must be counted (#3752)");
}

/// `None` opts out of counting entirely (used by callers whose own scan of
/// this model is not the one that gets reported, e.g. a pre-pass) — the
/// oversized reference is still excluded, just not counted twice.
#[test]
fn resolve_included_with_no_counter_still_excludes_the_oversized_reference() {
    let content = b"ISO-10303-21;\nHEADER;\nFILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\n#1=IFCWALL('g',$,$,$,$,#4294967297,$,$,$);\nENDSEC;\nEND-ISO-10303-21;\n";
    let idx = ModelIndex::build(content);
    let included = resolve_included(&idx, &Some(vec![1]), None);
    assert_eq!(included, HashSet::from([1]), "the oversized reference is excluded, not followed");
}

#[test]
fn parse_ref_helpers() {
    assert_eq!(parse_single_ref(" #42 "), Some(42));
    assert_eq!(parse_single_ref("$"), None);
    assert_eq!(parse_ref_list("(#1,#2,#3)"), vec![1, 2, 3]);
    assert_eq!(parse_ref_list("()"), Vec::<u32>::new());
}

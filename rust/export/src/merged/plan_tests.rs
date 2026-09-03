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
    assert_eq!(idx.max_id, 3);
    assert_eq!(idx.projects, vec![1]);
    assert_eq!(idx.site_count, 1);
    assert_eq!(idx.type_of.get(&2).map(String::as_str), Some("IFCSITE"));
}

#[test]
fn resolve_included_pulls_forward_closure() {
    let idx = ModelIndex::build(TWO_STOREYS.as_bytes());
    // Root at the rel: closure must pull in #1 (relating) and #2 (related).
    let mut refused = 0usize;
    let included = resolve_included(&idx, &Some(vec![3]), &mut refused);
    assert!(included.contains(&3) && included.contains(&1) && included.contains(&2));
    assert_eq!(refused, 0, "no reference in this fixture exceeds u32::MAX");
    // None → everything.
    assert_eq!(resolve_included(&idx, &None, &mut refused).len(), 3);
}

/// RED for issue #3752: a filtered model whose root references an oversized
/// id must count the refusal, not just silently exclude the closure it
/// would have pulled in (issue #3421 governs the exclusion itself).
#[test]
fn resolve_included_counts_a_refused_oversized_reference() {
    let content = b"ISO-10303-21;\nHEADER;\nFILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\n#1=IFCWALL('g',$,$,$,$,#4294967297,$,$,$);\nENDSEC;\nEND-ISO-10303-21;\n";
    let idx = ModelIndex::build(content);
    let mut refused = 0usize;
    let included = resolve_included(&idx, &Some(vec![1]), &mut refused);
    assert!(included.contains(&1));
    assert_eq!(refused, 1, "the oversized reference must be counted (#3752)");
}

#[test]
fn redundant_rel_aggregates_dropped_only_when_fully_shared() {
    let idx = ModelIndex::build(TWO_STOREYS.as_bytes());
    let mut skip = HashSet::new();
    // Both #1 and #2 unified → the rel #3 is redundant.
    let mut shared = HashMap::from([(1u32, 50u32), (2u32, 51u32)]);
    skip_redundant_rel_aggregates(&idx, &shared, &mut skip);
    assert!(skip.contains(&3));
    // Only relating shared → kept.
    skip.clear();
    shared.remove(&2);
    skip_redundant_rel_aggregates(&idx, &shared, &mut skip);
    assert!(!skip.contains(&3));
}

#[test]
fn parse_ref_helpers() {
    assert_eq!(parse_single_ref(" #42 "), Some(42));
    assert_eq!(parse_single_ref("$"), None);
    assert_eq!(parse_ref_list("(#1,#2,#3)"), vec![1, 2, 3]);
    assert_eq!(parse_ref_list("()"), Vec::<u32>::new());
}

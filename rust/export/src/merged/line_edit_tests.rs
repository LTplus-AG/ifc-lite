// SPDX-License-Identifier: MPL-2.0
//! Tests for `line_edit.rs`, split out under the house pattern (AGENTS.md):
//! the production module stays under the module-size ratchet, and this file is
//! exempt via the `_tests.rs` suffix.

use super::*;

fn dropped(ids: &[u32]) -> HashSet<u32> {
    ids.iter().copied().collect()
}

#[test]
fn rewrite_refs_offsets_and_redirects() {
    let mut remap = std::collections::HashMap::new();
    remap.insert(2u32, 100u32);
    let out = rewrite_refs(
        b"#3=IFCRELAGGREGATES('r #2',$,$,$,#1,(#2));",
        10,
        &|n| remap.get(&n).copied(),
    );
    // #1 offset by 10 → #11; #2 redirected → #100; '#2' in the string untouched.
    assert!(out.contains("#11,(#100))"));
    assert!(out.contains("'r #2'"));
}

#[test]
fn classifies_single_list_and_nested_references() {
    let line = "#9=IFCRELAGGREGATES('g',$,$,$,#1,(#2,#3));";
    let slots = classify_refs(line).expect("parseable line");
    assert_eq!(slots[0], (1, RefSlot::Single));
    assert_eq!(slots[1], (2, RefSlot::ListElement));
    assert_eq!(slots[2], (3, RefSlot::ListElement));
    // A reference one level deeper is neither removable nor line-fatal.
    let nested = classify_refs("#9=IFCX('g',((#4)),#5);").expect("parseable line");
    assert!(nested.contains(&(4, RefSlot::Nested)));
    assert!(nested.contains(&(5, RefSlot::Single)));
}

#[test]
fn an_unparseable_line_classifies_as_none_rather_than_as_empty() {
    // "no argument list" must be distinguishable from "names nothing": the drop
    // analysis blocks on the first and would happily drop on the second.
    assert!(classify_refs("#9=IFCRELAGGREGATES;").is_none());
    assert!(classify_refs("#9=IFCRELAGGREGATES('g',$,$,$,#1,(#2)").is_none());
}

#[test]
fn a_hash_inside_a_string_is_not_a_reference() {
    let slots = classify_refs("#9=IFCSITE('g',$,'Site #7',$,$,$,$,$,$);").expect("parseable line");
    assert!(slots.is_empty());
    let mut refs = Vec::new();
    arg_refs(b"#9=IFCSITE('g',$,'Site #7',$,$,$,$,$,$);", &mut refs);
    assert!(refs.is_empty(), "quoted text is not a reference: {refs:?}");
}

#[test]
fn arg_refs_skips_the_line_s_own_id() {
    let mut refs = Vec::new();
    arg_refs(b"#12=IFCRELAGGREGATES('g',$,$,$,#1,(#2));", &mut refs);
    assert_eq!(refs, vec![1, 2]);
}

#[test]
fn keeps_a_line_that_names_nothing_dropped() {
    let line = "#9=IFCRELAGGREGATES('g',$,$,$,#1,(#2,#3));";
    assert!(matches!(decide_line(line, &dropped(&[7])), LineDecision::Keep));
}

#[test]
fn strips_a_dropped_list_element_and_keeps_the_rest() {
    let line = "#9=IFCRELAGGREGATES('g',$,$,$,#1,(#2,#3));";
    let LineDecision::Rewrite(out) = decide_line(line, &dropped(&[2])) else {
        panic!("expected a rewrite");
    };
    assert_eq!(out, "#9=IFCRELAGGREGATES('g',$,$,$,#1,(#3));");
}

#[test]
fn drops_the_line_when_a_list_empties() {
    let line = "#9=IFCRELAGGREGATES('g',$,$,$,#1,(#2,#3));";
    assert!(matches!(decide_line(line, &dropped(&[2, 3])), LineDecision::Skip));
}

#[test]
fn drops_the_line_when_a_single_valued_reference_goes() {
    // Relating object dropped: the relationship has no subject left to name.
    let line = "#9=IFCRELCONTAINEDINSPATIALSTRUCTURE('g',$,$,$,(#2),#1);";
    assert!(matches!(decide_line(line, &dropped(&[1])), LineDecision::Skip));
}

#[test]
fn rewriting_preserves_every_other_attribute_verbatim() {
    // Commas, parentheses and hashes inside quoted text must survive untouched.
    let line = "#9=IFCRELDEFINESBYPROPERTIES('g',$,'A, (b) #2',$,(#2,#3),#4);";
    let LineDecision::Rewrite(out) = decide_line(line, &dropped(&[2])) else {
        panic!("expected a rewrite");
    };
    assert_eq!(out, "#9=IFCRELDEFINESBYPROPERTIES('g',$,'A, (b) #2',$,(#3),#4);");
}

// SPDX-License-Identifier: MPL-2.0
use super::*;

#[test]
fn empty_roots_keeps_nothing() {
    let lines: Vec<(u32, &str, &[u8])> = vec![
        (1, "IFCWALL", b"#1=IFCWALL('g',$);" as &[u8]),
        (2, "IFCWALL", b"#2=IFCWALL('h',$);"),
    ];
    let filter = VisibilityFilter { roots: vec![], excluded: vec![] };
    let keep = compute_keep_set(&lines, &filter);
    assert!(keep.is_empty(), "empty roots must keep nothing, got {keep:?}");
}

#[test]
fn roots_pull_in_forward_refs() {
    // #1 references #2; only #1 is a root, #2 must be pulled in by closure.
    let lines: Vec<(u32, &str, &[u8])> = vec![
        (1, "IFCWALL", b"#1=IFCWALL('g',#2);" as &[u8]),
        (2, "IFCLABEL", b"#2=IFCLABEL('x');"),
    ];
    let filter = VisibilityFilter { roots: vec![1], excluded: vec![] };
    let keep = compute_keep_set(&lines, &filter);
    assert_eq!(keep, HashSet::from([1, 2]));
}

#[test]
fn excluded_id_blocks_closure_even_when_referenced() {
    // #1 (a root) references hidden #2 -- closure must not pull #2 back in.
    let lines: Vec<(u32, &str, &[u8])> = vec![
        (1, "IFCSTYLEDITEM", b"#1=IFCSTYLEDITEM(#2);" as &[u8]),
        (2, "IFCWALL", b"#2=IFCWALL('h');"),
    ];
    let filter = VisibilityFilter { roots: vec![1], excluded: vec![2] };
    let keep = compute_keep_set(&lines, &filter);
    assert_eq!(keep, HashSet::from([1]));
}

#[test]
fn relationship_naming_an_excluded_set_member_survives_narrowed() {
    // #1 is IFCRELDEFINESBYPROPERTIES naming a SET with visible #2 and
    // hidden #3 -- one of TWO members excluded, so the SET narrows to just
    // #2 rather than the whole relationship being dropped (the pre-fix
    // behavior this test used to pin, proven wrong: a real exporter that
    // lists every element of a storey in one relationship would lose that
    // storey's containment for every OTHER element just because one sibling
    // was hidden). #4 (RelatingPropertyDefinition, single-valued, not
    // excluded) stays reachable through the narrowed relationship.
    let lines: Vec<(u32, &str, &[u8])> = vec![
        (1, "IFCRELDEFINESBYPROPERTIES", b"#1=IFCRELDEFINESBYPROPERTIES($,$,$,$,(#2,#3),#4);" as &[u8]),
        (2, "IFCWALL", b"#2=IFCWALL('v');"),
        (3, "IFCWALL", b"#3=IFCWALL('h');"),
        (4, "IFCPROPERTYSET", b"#4=IFCPROPERTYSET('p');"),
    ];
    let filter = VisibilityFilter { roots: vec![1, 2], excluded: vec![3] };
    let keep = compute_keep_set(&lines, &filter);
    assert!(keep.contains(&1), "narrowable relationship must survive, not be dropped whole: {keep:?}");
    assert!(keep.contains(&4), "still reachable through the narrowed relationship: {keep:?}");
    assert!(keep.contains(&2), "the visible product itself stays: {keep:?}");
    assert!(!keep.contains(&3), "excluded id never included: {keep:?}");
}

#[test]
fn relationship_whose_set_has_only_one_excluded_member_is_dropped_not_dangled() {
    // #1 names a SET whose ONLY member is excluded (#3) -- narrowing would
    // leave an empty SET, which is not valid STEP for a real IFC attribute,
    // so the whole line is withheld, same as before this module could narrow
    // anything. #4 (only reachable through #1) must not survive as an orphan.
    let lines: Vec<(u32, &str, &[u8])> = vec![
        (1, "IFCRELDEFINESBYPROPERTIES", b"#1=IFCRELDEFINESBYPROPERTIES($,$,$,$,(#3),#4);" as &[u8]),
        (3, "IFCWALL", b"#3=IFCWALL('h');"),
        (4, "IFCPROPERTYSET", b"#4=IFCPROPERTYSET('p');"),
    ];
    let filter = VisibilityFilter { roots: vec![1], excluded: vec![3] };
    let keep = compute_keep_set(&lines, &filter);
    assert!(!keep.contains(&1), "a SET with no surviving members must still withhold the whole line: {keep:?}");
    assert!(!keep.contains(&4), "unreachable once its only relationship is dropped: {keep:?}");
    assert!(!keep.contains(&3), "excluded id never included: {keep:?}");
}

#[test]
fn relationship_naming_only_included_ids_survives() {
    let lines: Vec<(u32, &str, &[u8])> = vec![
        (1, "IFCRELDEFINESBYPROPERTIES", b"#1=IFCRELDEFINESBYPROPERTIES($,$,$,$,(#2),#3);" as &[u8]),
        (2, "IFCWALL", b"#2=IFCWALL('v');"),
        (3, "IFCPROPERTYSET", b"#3=IFCPROPERTYSET('p');"),
    ];
    let filter = VisibilityFilter { roots: vec![1, 2], excluded: vec![] };
    let keep = compute_keep_set(&lines, &filter);
    assert_eq!(keep, HashSet::from([1, 2, 3]));
}

#[test]
fn ref_to_id_absent_from_model_is_left_alone() {
    // #1 references #99, which does not exist in this model at all -- not
    // our problem to fabricate or flag, just don't crash and don't keep it.
    let lines: Vec<(u32, &str, &[u8])> = vec![(1, "IFCWALL", b"#1=IFCWALL('g',#99);" as &[u8])];
    let filter = VisibilityFilter { roots: vec![1], excluded: vec![] };
    let keep = compute_keep_set(&lines, &filter);
    assert_eq!(keep, HashSet::from([1]));
}

// ---------------------------------------------------------------------------
// narrow_relationship_line -- direct pins on the emitted STEP text, one per
// shape `filterHiddenRefsFromRelationshipLine` distinguishes. Distinct id
// counts per case so none could pass on a miscounted fixture.
// ---------------------------------------------------------------------------

#[test]
fn narrow_line_shrinks_a_three_member_set_to_the_two_survivors() {
    let excluded = HashSet::from([30u32]);
    let line = "#10=IFCRELCONTAINEDINSPATIALSTRUCTURE($,$,$,$,(#1,#2,#30),#20);";
    let out = narrow_relationship_line(line, &|id| excluded.contains(&id));
    assert_eq!(out.as_deref(), Some("#10=IFCRELCONTAINEDINSPATIALSTRUCTURE($,$,$,$,(#1,#2),#20);"));
}

#[test]
fn narrow_line_drops_whole_line_when_a_sets_only_member_is_excluded() {
    let excluded = HashSet::from([7u32]);
    let line = "#5=IFCRELASSIGNSTOGROUP($,$,$,$,(#7),#8);";
    let out = narrow_relationship_line(line, &|id| excluded.contains(&id));
    assert_eq!(out, None, "an empty SET is a different kind of invalid file, not \"no reference\"");
}

#[test]
fn narrow_line_drops_whole_line_when_a_single_valued_slot_is_excluded() {
    let excluded = HashSet::from([9u32]);
    // RelatingBuildingElement=#2 (kept), RelatedOpeningElement=#9 (excluded,
    // single-valued -- no SET/LIST parens).
    let line = "#4=IFCRELVOIDSELEMENT($,$,$,$,#2,#9);";
    let out = narrow_relationship_line(line, &|id| excluded.contains(&id));
    assert_eq!(out, None, "a single-valued STEP attribute has no spelling for \"omitted\"");
}

#[test]
fn narrow_line_leaves_a_line_naming_nothing_excluded_byte_identical() {
    let line = "#10=IFCRELCONTAINEDINSPATIALSTRUCTURE($,$,$,$,(#1,#2,#3),#20);";
    let out = narrow_relationship_line(line, &|_id| false);
    assert_eq!(out.as_deref(), Some(line), "nothing excluded -- must pass through byte-identical");
}

#[test]
fn narrow_line_rewrites_ifcrelconnectsstructuralmember_optional_slot_to_dollar() {
    // Position 9 of 10 (ConditionCoordinateSystem) is schema-OPTIONAL --
    // rewritten to `$` instead of withholding the whole relationship.
    let excluded = HashSet::from([99u32]);
    let line = "#6=IFCRELCONNECTSSTRUCTURALMEMBER(#1,$,$,$,#2,#3,$,$,$,#99);";
    let out = narrow_relationship_line(line, &|id| excluded.contains(&id));
    assert_eq!(out.as_deref(), Some("#6=IFCRELCONNECTSSTRUCTURALMEMBER(#1,$,$,$,#2,#3,$,$,$,$);"));
}

#[test]
fn narrow_line_does_not_apply_the_optional_slot_exception_to_the_eccentricity_subtype() {
    // IFCRELCONNECTSWITHECCENTRICITY appends an 11th mandatory attribute,
    // shifting ConditionCoordinateSystem to position 8 of 11 -- outside the
    // narrow, type+count-matched exception, so this falls through to the
    // general single-valued withhold rule.
    let excluded = HashSet::from([99u32]);
    let line = "#6=IFCRELCONNECTSWITHECCENTRICITY(#1,$,$,$,#2,#3,$,$,#99,$,$);";
    let out = narrow_relationship_line(line, &|id| excluded.contains(&id));
    assert_eq!(out, None);
}

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
fn relationship_spanning_excluded_id_is_dropped_not_dangled() {
    // #1 is IFCRELDEFINESBYPROPERTIES naming visible #2 and hidden #3.
    let lines: Vec<(u32, &str, &[u8])> = vec![
        (1, "IFCRELDEFINESBYPROPERTIES", b"#1=IFCRELDEFINESBYPROPERTIES($,$,$,$,(#2,#3),#4);" as &[u8]),
        (2, "IFCWALL", b"#2=IFCWALL('v');"),
        (3, "IFCWALL", b"#3=IFCWALL('h');"),
        (4, "IFCPROPERTYSET", b"#4=IFCPROPERTYSET('p');"),
    ];
    // #1 and #2 are roots (relationship always a root; #2 is visible), #3 is
    // hidden/excluded, #4 only reachable through #1.
    let filter = VisibilityFilter { roots: vec![1, 2], excluded: vec![3] };
    let keep = compute_keep_set(&lines, &filter);
    // The relationship named an excluded id (#3), so it is dropped entirely
    // -- #4 (only reachable through it) never enters the closure, and no
    // kept line refers to #3.
    assert!(!keep.contains(&1), "dangling relationship must be dropped: {keep:?}");
    assert!(!keep.contains(&4), "unreachable once its only relationship is dropped: {keep:?}");
    assert!(keep.contains(&2), "the visible product itself stays: {keep:?}");
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

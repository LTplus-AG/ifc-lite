// SPDX-License-Identifier: MPL-2.0
//! Cases for [`merge_inherited`], mirroring
//! `packages/parser/test/merge-inherited-property-sets.test.ts`. The two
//! merges match; keep them, and these cases, in step.
//!
//! Each case names the behaviour it pins so a future change has to argue with
//! the name, not just the assertion.

use std::ops::Range;

use super::merge_inherited;
use crate::data_model::rows::{PropValue, PropertySet, QuantitySet, QuantityValue, ValueKind};

fn prop(name: &str, value: &str) -> PropValue {
    PropValue {
        name: name.to_string(),
        value: value.to_string(),
        value_type: "IFCLABEL".to_string(),
        kind: ValueKind::Text,
    }
}

fn pset(name: &str, props: &[(&str, &str)]) -> PropertySet {
    PropertySet {
        name: name.to_string(),
        properties: props.iter().map(|(n, v)| prop(n, v)).collect(),
    }
}

fn qty(name: &str, value: f64) -> QuantityValue {
    QuantityValue {
        name: name.to_string(),
        value,
        kind: "Length",
    }
}

/// The merged sets alone, for cases that do not look at provenance.
fn merge(own: Vec<PropertySet>, type_sets: Vec<PropertySet>) -> Vec<PropertySet> {
    merge_inherited(own, &type_sets).0
}

/// `(own names, inherited names)` for merged set `i`, checking that a set's
/// inherited entries all follow its own.
fn split<'a>(
    sets: &'a [PropertySet],
    ranges: &[Range<usize>],
    i: usize,
) -> (Vec<&'a str>, Vec<&'a str>) {
    let props = &sets[i].properties;
    let inherited = ranges.get(i).cloned().unwrap_or(props.len()..props.len());
    assert_eq!(
        inherited.end,
        props.len(),
        "set {i}: inherited entries come last"
    );
    let names = |r: Range<usize>| props[r].iter().map(|p| p.name.as_str()).collect();
    (names(0..inherited.start), names(inherited))
}

/// `(set name, [(prop name, value)])` for compact comparison.
fn shape(sets: &[PropertySet]) -> Vec<(String, Vec<(String, String)>)> {
    sets.iter()
        .map(|s| {
            (
                s.name.clone(),
                s.properties
                    .iter()
                    .map(|p| (p.name.clone(), p.value.clone()))
                    .collect(),
            )
        })
        .collect()
}

#[test]
fn no_inherited_sets_leaves_own_untouched() {
    let own = vec![pset("Pset_WallCommon", &[("IsExternal", "T")])];
    let merged = merge(own.clone(), Vec::new());
    assert_eq!(merged, own);
}

#[test]
fn an_occurrence_with_nothing_of_its_own_inherits_the_whole_set() {
    // The `pass-properties_can_be_inherited_from_the_type` corpus shape.
    let merged = merge(Vec::new(), vec![pset("Foo_Bar", &[("Foo", "Bar")])]);
    assert_eq!(
        shape(&merged),
        vec![(
            "Foo_Bar".to_string(),
            vec![("Foo".to_string(), "Bar".to_string())]
        )]
    );
}

#[test]
fn a_non_colliding_inherited_set_is_appended_after_the_own_ones() {
    let own = vec![pset("Pset_WallCommon", &[("IsExternal", "T")])];
    let inherited = vec![pset("Pset_ManufacturerTypeInformation", &[("Model", "X")])];
    let merged = merge(own, inherited);
    assert_eq!(
        merged.iter().map(|s| s.name.as_str()).collect::<Vec<_>>(),
        ["Pset_WallCommon", "Pset_ManufacturerTypeInformation"]
    );
}

#[test]
fn the_occurrence_wins_a_property_name_collision_and_type_only_props_survive() {
    // This is the #1913 fix: replacing the whole set would lose Combustible.
    let own = vec![pset("Pset_CoveringCommon", &[("Reference", "occurrence")])];
    let inherited = vec![pset(
        "Pset_CoveringCommon",
        &[("Reference", "type"), ("Combustible", "F")],
    )];
    let merged = merge(own, inherited);

    assert_eq!(merged.len(), 1, "same-named sets must not duplicate");
    assert_eq!(
        shape(&merged),
        vec![(
            "Pset_CoveringCommon".to_string(),
            vec![
                ("Reference".to_string(), "occurrence".to_string()),
                ("Combustible".to_string(), "F".to_string()),
            ]
        )],
        "occurrence value kept, type-only property appended after it"
    );
}

/// Every entry says where it came from: own, whole inherited and topped-up
/// sets alike.
#[test]
fn every_entry_is_marked_own_or_inherited() {
    let own = vec![
        pset("Pset_WallCommon", &[("IsExternal", "T")]),
        pset("Pset_OwnOnly", &[("A", "1")]),
    ];
    let inherited = vec![
        pset(
            "Pset_WallCommon",
            &[("IsExternal", "F"), ("FireRating", "60")],
        ),
        pset("Pset_TypeOnly", &[("B", "2"), ("C", "3")]),
    ];
    let (merged, ranges) = merge_inherited(own, &inherited);

    assert_eq!(merged.len(), 3);
    assert_eq!(
        split(&merged, &ranges, 0),
        (vec!["IsExternal"], vec!["FireRating"])
    );
    assert_eq!(split(&merged, &ranges, 1), (vec!["A"], vec![]));
    assert_eq!(split(&merged, &ranges, 2), (vec![], vec!["B", "C"]));
}

/// Two own sets of one name (one per `IfcRelDefinesByProperties`). Each is
/// topped up: IDS requires every set matching a facet to satisfy it, so a bare
/// twin would report a present property as missing. The copies are reported
/// as inherited, so a caller building keys can still prefer own entries.
#[test]
fn every_same_named_own_set_receives_the_additions_not_just_the_first() {
    let own = vec![
        pset("Pset_WallCommon", &[("IsExternal", "T")]),
        pset("Pset_WallCommon", &[("LoadBearing", "F")]),
    ];
    let inherited = vec![pset("Pset_WallCommon", &[("FireRating", "60")])];
    let (merged, ranges) = merge_inherited(own, &inherited);

    assert_eq!(merged.len(), 2);
    assert_eq!(
        split(&merged, &ranges, 0),
        (vec!["IsExternal"], vec!["FireRating"])
    );
    assert_eq!(
        split(&merged, &ranges, 1),
        (vec!["LoadBearing"], vec!["FireRating"])
    );
}

/// A twin that defines the property itself keeps its own value; only the
/// twin without it is topped up.
#[test]
fn a_twin_that_defines_the_property_keeps_its_own_value() {
    let own = vec![
        pset("Pset_WallCommon", &[("IsExternal", "T")]),
        pset("Pset_WallCommon", &[("FireRating", "occurrence")]),
    ];
    let inherited = vec![pset("Pset_WallCommon", &[("FireRating", "type")])];
    let (merged, ranges) = merge_inherited(own, &inherited);

    assert_eq!(
        split(&merged, &ranges, 0),
        (vec!["IsExternal"], vec!["FireRating"])
    );
    assert_eq!(split(&merged, &ranges, 1), (vec!["FireRating"], vec![]));
    assert_eq!(merged[1].properties[0].value, "occurrence");
}

#[test]
fn two_inherited_sets_of_one_name_stay_separate_rather_than_folding() {
    // An appended set is never matched by a later inherited one. Folding them
    // would collapse two distinct type-side sets into one, which is a
    // different operation from inheriting.
    let inherited = vec![
        pset("Foo_Bar", &[("A", "1")]),
        pset("Foo_Bar", &[("A", "2"), ("B", "2")]),
    ];
    let (merged, ranges) = merge_inherited(Vec::new(), &inherited);

    assert_eq!(
        merged.len(),
        2,
        "expected two separate sets, got {merged:?}"
    );
    assert_eq!(split(&merged, &ranges, 0), (vec![], vec!["A"]));
    assert_eq!(split(&merged, &ranges, 1), (vec![], vec!["A", "B"]));
}

#[test]
fn an_unnamed_inherited_set_is_not_folded_into_an_unnamed_own_set() {
    // Same rule as the TS merge: an absent name is no evidence of sameness.
    let own = vec![pset("", &[("Shared", "occurrence")])];
    let inherited = vec![pset("", &[("Shared", "type"), ("TypeOnly", "2")])];
    let (merged, ranges) = merge_inherited(own, &inherited);

    assert_eq!(merged.len(), 2);
    assert_eq!(split(&merged, &ranges, 0), (vec!["Shared"], vec![]));
    assert_eq!(
        split(&merged, &ranges, 1),
        (vec![], vec!["Shared", "TypeOnly"])
    );
}

#[test]
fn an_inherited_set_adding_nothing_new_changes_nothing() {
    let own = vec![pset("Pset_WallCommon", &[("IsExternal", "T")])];
    let merged = merge(
        own.clone(),
        vec![pset("Pset_WallCommon", &[("IsExternal", "F")])],
    );
    assert_eq!(merged, own);
}

#[test]
fn quantity_sets_follow_the_same_rule() {
    let own = vec![QuantitySet {
        name: "Qto_WallBaseQuantities".to_string(),
        quantities: vec![qty("Length", 3000.0)],
    }];
    let inherited = vec![QuantitySet {
        name: "Qto_WallBaseQuantities".to_string(),
        quantities: vec![qty("Length", 9999.0), qty("Width", 200.0)],
    }];
    let (merged, ranges) = merge_inherited(own, &inherited);

    assert_eq!(merged.len(), 1);
    let names: Vec<&str> = merged[0]
        .quantities
        .iter()
        .map(|q| q.name.as_str())
        .collect();
    assert_eq!(names, ["Length", "Width"]);
    assert_eq!(ranges, vec![1..2], "only Width is inherited");
    assert_eq!(
        merged[0].quantities[0].value, 3000.0,
        "the occurrence's own Length must win"
    );
}

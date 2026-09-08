// SPDX-License-Identifier: MPL-2.0
//! Cases for [`merge_inherited`], mirroring the rules documented on
//! `mergeInheritedPropertySets` in `packages/parser/src/property-set-merge.ts`.
//!
//! The TS side has no test file of its own, so these are the only executable
//! statement of the rule in the repo. Each case names the behaviour it pins so
//! a future change has to argue with the name, not just the assertion.

use super::merge_inherited;
use crate::model::{PropValue, PropertySet, QuantitySet, QuantityValue};

fn prop(name: &str, value: &str) -> PropValue {
    PropValue {
        name: name.to_string(),
        value: value.to_string(),
        value_type: "IFCLABEL".to_string(),
    }
}

fn pset(name: &str, props: &[(&str, &str)]) -> PropertySet {
    PropertySet {
        name: name.to_string(),
        properties: props.iter().map(|(n, v)| prop(n, v)).collect(),
    }
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
    let merged = merge_inherited(own.clone(), Vec::new());
    assert_eq!(shape(&merged), shape(&own));
}

#[test]
fn an_occurrence_with_nothing_of_its_own_inherits_the_whole_set() {
    // The `pass-properties_can_be_inherited_from_the_type` corpus shape.
    let merged = merge_inherited(Vec::new(), vec![pset("Foo_Bar", &[("Foo", "Bar")])]);
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
    let merged = merge_inherited(own, inherited);
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
    let merged = merge_inherited(own, inherited);

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

#[test]
fn every_same_named_own_set_receives_the_additions_not_just_the_first() {
    // Federated/merged exports produce twins; augmenting only one reintroduces
    // the false "property not found" this rule exists to prevent.
    let own = vec![
        pset("Pset_WallCommon", &[("IsExternal", "T")]),
        pset("Pset_WallCommon", &[("IsExternal", "F")]),
    ];
    let inherited = vec![pset("Pset_WallCommon", &[("FireRating", "60")])];
    let merged = merge_inherited(own, inherited);

    assert_eq!(merged.len(), 2);
    for set in &merged {
        assert!(
            set.properties.iter().any(|p| p.name == "FireRating"),
            "both twins must gain FireRating, got {:?}",
            set.properties
        );
    }
}

#[test]
fn two_inherited_sets_of_one_name_stay_separate_rather_than_folding() {
    // The appended set is deliberately not registered in the name index.
    // Folding them would collapse two distinct type-side sets into one, which
    // is a different operation from inheriting.
    let inherited = vec![
        pset("Foo_Bar", &[("A", "1")]),
        pset("Foo_Bar", &[("B", "2")]),
    ];
    let merged = merge_inherited(Vec::new(), inherited);

    assert_eq!(merged.len(), 2, "expected two separate sets, got {merged:?}");
    assert_eq!(merged[0].properties.len(), 1);
    assert_eq!(merged[1].properties.len(), 1);
}

#[test]
fn an_inherited_set_adding_nothing_new_changes_nothing() {
    let own = vec![pset("Pset_WallCommon", &[("IsExternal", "T")])];
    let merged = merge_inherited(own.clone(), vec![pset("Pset_WallCommon", &[("IsExternal", "F")])]);
    assert_eq!(shape(&merged), shape(&own));
}

#[test]
fn quantity_sets_follow_the_same_rule() {
    let own = vec![QuantitySet {
        name: "Qto_WallBaseQuantities".to_string(),
        quantities: vec![QuantityValue {
            name: "Length".to_string(),
            value: 3000.0,
            kind: "Length",
        }],
    }];
    let inherited = vec![QuantitySet {
        name: "Qto_WallBaseQuantities".to_string(),
        quantities: vec![
            QuantityValue {
                name: "Length".to_string(),
                value: 9999.0,
                kind: "Length",
            },
            QuantityValue {
                name: "Width".to_string(),
                value: 200.0,
                kind: "Length",
            },
        ],
    }];
    let merged = merge_inherited(own, inherited);

    assert_eq!(merged.len(), 1);
    let names: Vec<&str> = merged[0]
        .quantities
        .iter()
        .map(|q| q.name.as_str())
        .collect();
    assert_eq!(names, ["Length", "Width"]);
    assert_eq!(
        merged[0].quantities[0].value, 3000.0,
        "the occurrence's own Length must win"
    );
}

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use super::{Component, Field, FieldValue, Node, NodeKind, Role, SetKind};
use crate::address::Address;

fn field(name: &str, value: Option<&str>) -> Field {
    Field {
        name: name.to_owned(),
        value: value.map_or(FieldValue::Absent, |text| FieldValue::Text(text.to_owned())),
    }
}

fn pset(name: &str, members: &[(&str, Option<&str>)]) -> Node {
    Node::Set {
        kind: SetKind::Property,
        name: name.to_owned(),
        members: members.iter().map(|(n, v)| field(n, *v)).collect(),
    }
}

fn element(ifc_type: &str, components: &[(&str, Address)]) -> Node {
    Node::Element {
        ifc_type: ifc_type.to_owned(),
        components: components
            .iter()
            .map(|(key, node)| Component {
                key: (*key).to_owned(),
                node: *node,
            })
            .collect(),
    }
}

#[test]
fn kind_tags_are_stable() {
    // Renumbering a tag rewrites every address of that kind, so the mapping is
    // pinned rather than left to the enum's declaration order.
    assert_eq!(NodeKind::Element as u8, 1);
    assert_eq!(NodeKind::PropertySet as u8, 2);
    assert_eq!(NodeKind::QuantitySet as u8, 3);
    assert_eq!(NodeKind::Relationship as u8, 4);
    assert_eq!(NodeKind::Geometry as u8, 5);
    assert_eq!(NodeKind::NameBag as u8, 6);
}

#[test]
fn property_and_quantity_sets_do_not_collide() {
    // Same name, same members, different kind: the kind tag must separate them.
    let property = Node::Set {
        kind: SetKind::Property,
        name: "Common".to_owned(),
        members: vec![field("A", Some("1"))],
    };
    let quantity = Node::Set {
        kind: SetKind::Quantity,
        name: "Common".to_owned(),
        members: vec![field("A", Some("1"))],
    };
    assert_ne!(property.address(), quantity.address());
}

#[test]
fn member_order_does_not_reach_the_address() {
    let forward = pset(
        "Pset_WallCommon",
        &[("IsExternal", Some("T")), ("FireRating", Some("EI60"))],
    );
    let reverse = pset(
        "Pset_WallCommon",
        &[("FireRating", Some("EI60")), ("IsExternal", Some("T"))],
    );
    assert_eq!(forward.address(), reverse.address());
}

#[test]
fn a_changed_member_value_moves_the_address() {
    let before = pset("P", &[("FireRating", Some("EI60"))]);
    let after = pset("P", &[("FireRating", Some("EI90"))]);
    assert_ne!(before.address(), after.address());
}

#[test]
fn absent_and_empty_member_values_differ() {
    let absent = pset("P", &[("A", None)]);
    let empty = pset("P", &[("A", Some(""))]);
    assert_ne!(
        absent.address(),
        empty.address(),
        "a property with no value must not hash like one with an empty value"
    );
}

#[test]
fn same_named_members_are_totally_ordered() {
    // Two members sharing a name must not let input order reach the hash. A
    // name-only sort is stable, so it would.
    let forward = pset("P", &[("A", Some("1")), ("A", Some("2"))]);
    let reverse = pset("P", &[("A", Some("2")), ("A", Some("1"))]);
    assert_eq!(forward.address(), reverse.address());
}

#[test]
fn duplicate_names_are_kept_because_cardinality_is_content() {
    let once = pset("P", &[("A", Some("1"))]);
    let twice = pset("P", &[("A", Some("1")), ("A", Some("1"))]);
    assert_ne!(once.address(), twice.address());
}

#[test]
fn component_order_does_not_reach_the_element_address() {
    let a = pset("Pset_A", &[("X", Some("1"))]).address();
    let b = pset("Pset_B", &[("Y", Some("2"))]).address();
    let forward = element("IfcWall", &[("pset:Pset_A", a), ("pset:Pset_B", b)]);
    let reverse = element("IfcWall", &[("pset:Pset_B", b), ("pset:Pset_A", a)]);
    assert_eq!(forward.address(), reverse.address());
}

/// The localisation rule, as an address-level assertion.
#[test]
fn editing_one_property_set_moves_only_that_node_and_its_owner() {
    let untouched = pset("Pset_B", &[("Y", Some("2"))]);
    let before = pset("Pset_A", &[("X", Some("1"))]);
    let after = pset("Pset_A", &[("X", Some("CHANGED"))]);

    let owner_before = element(
        "IfcWall",
        &[
            ("pset:Pset_A", before.address()),
            ("pset:Pset_B", untouched.address()),
        ],
    );
    let owner_after = element(
        "IfcWall",
        &[
            ("pset:Pset_A", after.address()),
            ("pset:Pset_B", untouched.address()),
        ],
    );

    // The edited set moved.
    assert_ne!(before.address(), after.address());
    // The owner moved, because it encodes the child's address.
    assert_ne!(owner_before.address(), owner_after.address());
    // Nothing else did.
    assert_eq!(
        untouched.address(),
        pset("Pset_B", &[("Y", Some("2"))]).address()
    );
}

/// The deduplication the node model buys, which is also what makes a shared
/// property set one change rather than N.
#[test]
fn identical_content_shares_one_address() {
    let left = pset("Pset_WallCommon", &[("IsExternal", Some("T"))]);
    let right = pset("Pset_WallCommon", &[("IsExternal", Some("T"))]);
    assert_eq!(left.address(), right.address());

    // And two elements carrying it reference the same node.
    let shared = left.address();
    let first = element("IfcWall", &[("pset:Pset_WallCommon", shared)]);
    let second = element("IfcWall", &[("pset:Pset_WallCommon", shared)]);
    assert_eq!(first.address(), second.address());
}

/// The whole point: a node carries no key, so regenerating every `GlobalId`
/// cannot move a single node address.
#[test]
fn a_node_address_is_content_only_and_carries_no_key() {
    // Two occurrences that are byte-identical in content differ only by the
    // key a tree would name them with. Since the key is not in the node, the
    // addresses are equal — which is exactly why a re-GUID is invisible here.
    let content = &[(
        "attr:core",
        pset("core", &[("Name", Some("W-01"))]).address(),
    )];
    let first = element("IfcWall", content);
    let second = element("IfcWall", content);
    assert_eq!(first.address(), second.address());

    // Sanity: the element variant has no field that could hold a key.
    match &first {
        Node::Element {
            ifc_type,
            components,
        } => {
            assert_eq!(ifc_type, "IfcWall");
            assert_eq!(components.len(), 1);
        }
        other => panic!("expected an element node, got {other:?}"),
    }
}

#[test]
fn ifc_type_participates_in_the_element_address() {
    let component = &[("attr:core", Address::of(b"x"))];
    assert_ne!(
        element("IfcWall", component).address(),
        element("IfcSlab", component).address()
    );
}

#[test]
fn relationship_role_target_order_does_not_reach_the_address() {
    let a = Address::of(b"a");
    let b = Address::of(b"b");
    let forward = Node::Relationship {
        ifc_type: "IfcRelAggregates".to_owned(),
        roles: vec![Role {
            name: "RelatedObjects".to_owned(),
            targets: vec![a, b],
        }],
    };
    let reverse = Node::Relationship {
        ifc_type: "IfcRelAggregates".to_owned(),
        roles: vec![Role {
            name: "RelatedObjects".to_owned(),
            targets: vec![b, a],
        }],
    };
    assert_eq!(forward.address(), reverse.address());
}

#[test]
fn relationship_role_name_matters() {
    let target = Address::of(b"t");
    let relating = Node::Relationship {
        ifc_type: "IfcRelAggregates".to_owned(),
        roles: vec![Role {
            name: "RelatingObject".to_owned(),
            targets: vec![target],
        }],
    };
    let related = Node::Relationship {
        ifc_type: "IfcRelAggregates".to_owned(),
        roles: vec![Role {
            name: "RelatedObjects".to_owned(),
            targets: vec![target],
        }],
    };
    assert_ne!(relating.address(), related.address());
}

#[test]
fn name_bag_order_does_not_matter_but_duplicates_do() {
    let bag = |names: &[&str]| Node::NameBag {
        kind: "material".to_owned(),
        names: names.iter().map(|n| (*n).to_owned()).collect(),
    };
    assert_eq!(
        bag(&["steel", "concrete"]).address(),
        bag(&["concrete", "steel"]).address()
    );
    assert_ne!(
        bag(&["steel"]).address(),
        bag(&["steel", "steel"]).address()
    );
}

#[test]
fn name_bag_kind_separates_materials_from_classifications() {
    let names = vec!["EF_25_10".to_owned()];
    let material = Node::NameBag {
        kind: "material".to_owned(),
        names: names.clone(),
    };
    let classification = Node::NameBag {
        kind: "classification".to_owned(),
        names,
    };
    assert_ne!(material.address(), classification.address());
}

#[test]
fn geometry_tier_and_digest_both_participate() {
    let make = |tier: &str, digest: &str| Node::Geometry {
        tier: tier.to_owned(),
        digest: digest.to_owned(),
    };
    assert_ne!(
        make("tessellated", "d1").address(),
        make("tessellated", "d2").address()
    );
    assert_ne!(
        make("tessellated", "d1").address(),
        make("wireframe", "d1").address()
    );
}

#[test]
fn encoding_is_deterministic_across_calls() {
    let node = pset("P", &[("A", Some("1")), ("B", None)]);
    let (first_address, first_bytes) = node.encode();
    let (second_address, second_bytes) = node.encode();
    assert_eq!(first_address, second_address);
    assert_eq!(first_bytes, second_bytes);
}

#[test]
fn astral_member_names_sort_by_normalized_utf8_bytes() {
    // The ordering choice, visible at the node level. Member order must not
    // reach the address either way...
    let forward = pset("P", &[("\u{E000}", Some("1")), ("\u{10000}", Some("2"))]);
    let reverse = pset("P", &[("\u{10000}", Some("2")), ("\u{E000}", Some("1"))]);
    assert_eq!(forward.address(), reverse.address());

    // ...and the encoding must put U+E000 first, which is UTF-8 byte order
    // (node-hash v0's rule) and the reverse of UTF-16 code-unit order (which
    // `rust/diff` uses to match V8). Getting this backwards is how an earlier
    // draft of this crate silently diverged from v0.
    let (_, bytes) = forward.encode();
    let find = |needle: &[u8]| {
        bytes
            .windows(needle.len())
            .position(|w| w == needle)
            .expect("member name present in the encoding")
    };
    assert!(
        find("\u{E000}".as_bytes()) < find("\u{10000}".as_bytes()),
        "normalized UTF-8 byte order puts U+E000 first"
    );
}

#[test]
fn unicode_spelling_does_not_change_a_node_address() {
    // Two authoring tools exporting the same property set with different
    // Unicode normalization must produce one node.
    let nfc = pset("Pset_B\u{e9}ton", &[("Styrke", Some("C30"))]);
    let nfd = pset("Pset_Be\u{301}ton", &[("Styrke", Some("C30"))]);
    assert_eq!(nfc.address(), nfd.address());
}

// Review on #8265: the `Set` branch tie-breaks name-then-value so input order
// cannot reach the hash, but the `Element` and `Relationship` branches sorted
// on the name alone with a stable sort. `Node` is public and enforces no
// uniqueness, and duplicate same-named property sets are a real IFC shape
// (#8136), so a tie was reachable and the caller's order decided the bytes.

#[test]
fn two_components_sharing_a_key_do_not_let_input_order_reach_the_address() {
    let x = Address::of(b"x");
    let y = Address::of(b"y");
    let forward = element("IfcWall", &[("pset:A", x), ("pset:A", y)]);
    let reverse = element("IfcWall", &[("pset:A", y), ("pset:A", x)]);
    assert_eq!(
        forward.address(),
        reverse.address(),
        "a duplicate component key must still be totally ordered"
    );
}

#[test]
fn two_roles_sharing_a_name_do_not_let_input_order_reach_the_address() {
    let a = Address::of(b"a");
    let b = Address::of(b"b");
    let role = |targets: Vec<Address>| Role {
        name: "RelatedObjects".to_owned(),
        targets,
    };
    let forward = Node::Relationship {
        ifc_type: "IfcRelAggregates".to_owned(),
        roles: vec![role(vec![a]), role(vec![b])],
    };
    let reverse = Node::Relationship {
        ifc_type: "IfcRelAggregates".to_owned(),
        roles: vec![role(vec![b]), role(vec![a])],
    };
    assert_eq!(
        forward.address(),
        reverse.address(),
        "two roles sharing a name must still be totally ordered"
    );
}

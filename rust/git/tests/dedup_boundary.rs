// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Where content-addressed deduplication stops being free, measured.
//!
//! Content-only node addresses mean two entities with identical content share
//! one address. A review of the spec set (PR #8039) raised the consequence for
//! relationships: a `relationship` node names its endpoints by node address,
//! so if two distinct occurrences dedupe, a relationship naming one names both.
//! The spec claimed cardinality survives at the tree layer, and that needed
//! proving at the node layer.
//!
//! These tests draw the boundary exactly, because prose was not going to
//! settle it:
//!
//! 1. Two occurrences differing **only in placement** do not dedupe, so the
//!    ordinary case has no ambiguity at all.
//! 2. Dedup requires identity in **every** component, placement included —
//!    genuinely coincident duplicates.
//! 3. Two relationships over coincident duplicates do collapse to one node.
//! 4. The **tree still carries both keys**, so cardinality is not lost. This is
//!    git's own arrangement: two identical files are two tree entries pointing
//!    at one blob.
//!
//! What the tree preserves is *how many* occurrences there are. It does not
//! recover *which* of them a collapsed relationship named, and the two are not
//! the same guarantee.
//!
//! # What the measurements do not mean
//!
//! An earlier version of these docs said the residual question — which of two
//! coincident openings a given void targets — "has no observable answer, since
//! the two differ in nothing a model records". That was false, and the spec
//! set has been corrected (`docs/architecture/ifc-git/02-graph-object-model.md`
//! §2.8). Coincident duplicates have **distinct `GlobalId`s**, and the source
//! IFC relationships name one or the other. The model does record the
//! association. It is this encoding — relationship endpoints as node addresses
//! rather than tree keys — that discards it. The information is not absent
//! from the source; it is dropped in projection, which is a different and more
//! serious thing.
//!
//! So the equivalence policy for coincident duplicates is **OPEN**, not
//! resolved: whether two coincident occurrences are one node or must be
//! separated, and if separated, by what that is not a `GlobalId`. Node-address
//! endpoints remain the current proposal, because tree-key endpoints put
//! `GlobalId` back inside the hash. Nothing in this file decides that.
//!
//! One consequence reaches the no-empty-commit rule (§2.7): retargeting a void
//! from occurrence A to its coincident twin B changes the model and changes
//! nothing this encoding can see, so the keyed diff is empty and no commit is
//! written. The two tests that pinned that hole asserted
//! `CommitError::Empty` directly, so they travel with `commit.rs` to the issue
//! that lands it once §2.8 is decided (#8262). What stays here is the half
//! that needs no commit object: that the duplicates share one node address,
//! that placement alone separates them, that relationships over them
//! collapse, and that the tree still preserves the cardinality the node layer
//! does not.
//!
//! The implementation limit that still bites: a consumer reconstructing from
//! nodes alone, bypassing the tree, would see one occurrence where there are
//! two. Reconstruction goes through the tree, because that is where keys live.

use ifc_lite_git::address::Address;
use ifc_lite_git::tree::{build_tree, TreeEntry};
use ifc_lite_git::{Component, Field, FieldValue, Node, Role, SetKind};

/// A placement component at a given X offset.
fn placement_at(x: &str) -> Address {
    Node::Set {
        kind: SetKind::Property,
        name: "placement".to_owned(),
        members: vec![Field {
            name: "X".to_owned(),
            value: FieldValue::Text(x.to_owned()),
        }],
    }
    .address()
}

/// An opening whose only component is its placement.
fn opening_at(x: &str) -> Node {
    Node::Element {
        ifc_type: "IfcOpeningElement".to_owned(),
        components: vec![Component {
            key: "placement".to_owned(),
            node: placement_at(x),
        }],
    }
}

fn voids(target: Address) -> Node {
    Node::Relationship {
        ifc_type: "IfcRelVoidsElement".to_owned(),
        roles: vec![Role {
            name: "RelatedOpeningElement".to_owned(),
            targets: vec![target],
        }],
    }
}

#[test]
fn occurrences_differing_only_in_placement_do_not_dedupe() {
    // The ordinary case: two openings in one wall are at different positions,
    // so they carry different placement components and never collide. This is
    // why the dedup concern is narrow rather than general.
    let first = opening_at("0");
    let second = opening_at("1000");
    assert_ne!(first.address(), second.address());

    // And so their voids stay distinct too.
    assert_ne!(
        voids(first.address()).address(),
        voids(second.address()).address()
    );
}

#[test]
fn dedup_requires_identity_in_every_component() {
    // Adding any distinguishing component separates them again, so an adapter
    // that projects placement — which the component vocabulary provides for —
    // cannot produce an accidental collapse.
    let bare = Node::Element {
        ifc_type: "IfcOpeningElement".to_owned(),
        components: vec![Component {
            key: "placement".to_owned(),
            node: placement_at("0"),
        }],
    };
    let with_pset = Node::Element {
        ifc_type: "IfcOpeningElement".to_owned(),
        components: vec![
            Component {
                key: "placement".to_owned(),
                node: placement_at("0"),
            },
            Component {
                key: "pset:Pset_OpeningElementCommon".to_owned(),
                node: Address::of(b"anything"),
            },
        ],
    };
    assert_ne!(bare.address(), with_pset.address());
}

#[test]
fn coincident_duplicates_share_one_node_address() {
    // The residual case: two openings identical in every recorded component,
    // including placement. In the source they still carry distinct
    // `GlobalId`s; this encoding does not see those.
    let first = opening_at("0");
    let second = opening_at("0");
    assert_eq!(first.address(), second.address());
}

#[test]
fn relationships_over_coincident_duplicates_collapse() {
    // Stated so the consequence is visible rather than surprising.
    let first = opening_at("0");
    let second = opening_at("0");
    assert_eq!(
        voids(first.address()).address(),
        voids(second.address()).address(),
        "identical relationships over identical endpoints are one node"
    );
}

/// What the tree preserves: cardinality lives in the tree, not in the node
/// layer. This is a measurement of one guarantee, not a resolution of the
/// endpoint question — see the module docs.
#[test]
fn the_tree_preserves_cardinality_that_the_node_layer_collapses() {
    let first = opening_at("0");
    let second = opening_at("0");
    let void_a = voids(first.address());
    let void_b = voids(second.address());

    let (tree, chunks) = build_tree(vec![
        TreeEntry {
            key: "OPENING-A".to_owned(),
            node: first.address(),
            ifc_type: "IfcOpeningElement".to_owned(),
        },
        TreeEntry {
            key: "OPENING-B".to_owned(),
            node: second.address(),
            ifc_type: "IfcOpeningElement".to_owned(),
        },
        TreeEntry {
            key: "VOID-A".to_owned(),
            node: void_a.address(),
            ifc_type: "IfcRelVoidsElement".to_owned(),
        },
        TreeEntry {
            key: "VOID-B".to_owned(),
            node: void_b.address(),
            ifc_type: "IfcRelVoidsElement".to_owned(),
        },
    ]);

    // Four named things.
    assert_eq!(tree.entry_count, 4, "the tree names every occurrence");

    // Referencing two distinct nodes, because the duplicates deduplicated.
    let distinct: std::collections::HashSet<Address> = chunks
        .iter()
        .flat_map(|chunk| chunk.entries.iter().map(|entry| entry.node))
        .collect();
    assert_eq!(
        distinct.len(),
        2,
        "two openings and two voids collapse to two nodes"
    );

    // This is exactly git's arrangement for two identical files, and it is why
    // the spec's cardinality claim holds at the layer that makes it.
}

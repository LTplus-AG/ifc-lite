// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Known-answer vectors, one per [`NodeKind`].
//!
//! Review on #8265: every existing test compares two encodings against each
//! other, so none of them pins an actual byte or an actual address — the
//! reviewer demonstrated this by shifting every `u32`/`f64_bits` field to
//! big-endian and every tag by 7 in a scratch copy, and all of them still
//! passed. These build the expected bytes independently of
//! [`CanonicalWriter`] (plain `u32::to_le_bytes`, length-prefixing done by
//! hand), so a change to the writer's actual output — byte order, tag width,
//! field order — moves `expected` out of step with the real encoding and the
//! vector fails. Each pins its [`Address::tagged`] string too, captured from
//! a real run rather than invented, so a port in another language has
//! something to match against.
//!
//! Coverage asked for: NFC input (`property_set`), a zero/negative float
//! (`property_set`), an absent value (`quantity_set`), and a duplicate key
//! (`element`).

use crate::address::canonical_bytes;
use crate::{Address, Component, Field, FieldValue, Node, Role, SetKind};

/// A content address built from a literal repeated byte, not a hash of
/// meaningful content — so the *child* addresses embedded in a vector's
/// bytes are exact and known without having to hand-compute a BLAKE3 digest.
/// Only the vector's own top-level address, pinned below, comes from an
/// actual run.
fn addr(byte: u8) -> Address {
    let hex = format!("{byte:02x}").repeat(32);
    Address::parse(&format!("blake3:{hex}")).expect("valid test address")
}

fn le_u32(value: u32) -> [u8; 4] {
    value.to_le_bytes()
}

/// A length-prefixed, NFC-normalized string, built the way the spec (and
/// `CanonicalWriter::string`) says to, not by calling it.
fn framed_string(value: &str) -> Vec<u8> {
    let bytes = canonical_bytes(value);
    let mut out = le_u32(u32::try_from(bytes.len()).expect("test string too long")).to_vec();
    out.extend_from_slice(&bytes);
    out
}

fn header(kind: u8) -> Vec<u8> {
    let mut out = b"IGN1".to_vec();
    out.push(kind);
    out.push(0); // NODE_FORMAT_VERSION
    out
}

/// Asserts the node's actual bytes equal `expected` byte for byte, and its
/// actual address equals the pinned `tagged` string.
fn assert_vector(node: &Node, expected: &[u8], tagged: &str) {
    let (address, bytes) = node.encode();
    assert_eq!(
        bytes, expected,
        "encoded bytes do not match the pinned vector"
    );
    assert_eq!(
        address.tagged(),
        tagged,
        "address moved — a wire-format change is invisible to every other test in this crate"
    );
}

#[test]
fn element_with_a_duplicate_key() {
    // Two occurrences of the same property set under one element is a real
    // IFC shape (#8136): both components keep the key `k`, tie-broken by
    // their own (known, literal) child address.
    let node = Node::Element {
        ifc_type: "IfcWall".to_owned(),
        components: vec![
            Component {
                key: "k".to_owned(),
                node: addr(0x11),
            },
            Component {
                key: "k".to_owned(),
                node: addr(0x00),
            },
        ],
    };

    let mut expected = header(1); // NodeKind::Element
    expected.extend(framed_string("IfcWall"));
    expected.extend(le_u32(2));
    // addr(0x00) sorts before addr(0x11): same key, tie-broken on the child
    // address, and `[0x00; 32] < [0x11; 32]` byte for byte.
    expected.extend(framed_string("k"));
    expected.extend([0x00; 32]);
    expected.extend(framed_string("k"));
    expected.extend([0x11; 32]);

    assert_vector(
        &node,
        &expected,
        "blake3:1ea29a72431338e66c16455cc9e2d43cd671a8ff3a3a5788c8e17f1d1a90a7b8",
    );
}

#[test]
fn property_set_with_nfc_input_and_a_negative_zero() {
    // The name arrives decomposed (NFD): two authoring tools must not produce
    // two hashes for one canonical name. The value is `-0.0`: it must hash
    // like `0.0`, not like a distinct float.
    let node = Node::Set {
        kind: SetKind::Property,
        name: "Pset_Be\u{301}ton".to_owned(), // NFD: "e" + combining acute
        members: vec![Field {
            name: "A".to_owned(),
            value: FieldValue::Number(-0.0),
        }],
    };

    let mut expected = header(2); // NodeKind::PropertySet
    expected.extend(framed_string("Pset_B\u{e9}ton")); // NFC: precomposed é
    expected.extend(le_u32(1));
    expected.extend(framed_string("A"));
    expected.push(2); // FieldValue::Number tag
    expected.extend(0.0_f64.to_le_bytes()); // -0.0 canonicalizes to +0.0's bits

    assert_vector(
        &node,
        &expected,
        "blake3:db7b235b8604ba837b6600d3150195fd7dc44a7519f97c39125206bbe141bb79",
    );
}

#[test]
fn quantity_set_with_an_absent_value() {
    // `Absent` writes its tag and nothing else — no length, no payload.
    let node = Node::Set {
        kind: SetKind::Quantity,
        name: "Qto_WallBaseQuantities".to_owned(),
        members: vec![Field {
            name: "Width".to_owned(),
            value: FieldValue::Absent,
        }],
    };

    let mut expected = header(3); // NodeKind::QuantitySet
    expected.extend(framed_string("Qto_WallBaseQuantities"));
    expected.extend(le_u32(1));
    expected.extend(framed_string("Width"));
    expected.push(0); // FieldValue::Absent tag, no payload

    assert_vector(
        &node,
        &expected,
        "blake3:016fd1b35da03ac7a0b9dc398ae6ebc468998d8d0be8fa3f56787d5f2b04e961",
    );
}

#[test]
fn attributes_with_a_bool_member() {
    let node = Node::Set {
        kind: SetKind::Attributes,
        name: "core".to_owned(),
        members: vec![Field {
            name: "IsExternal".to_owned(),
            value: FieldValue::Bool(true),
        }],
    };

    let mut expected = header(7); // NodeKind::Attributes
    expected.extend(framed_string("core"));
    expected.extend(le_u32(1));
    expected.extend(framed_string("IsExternal"));
    expected.push(3); // FieldValue::Bool tag
    expected.push(1); // true, one byte — not the four `u32` used to write

    assert_vector(
        &node,
        &expected,
        "blake3:a5e0eb4d6316412f50c335f2f21a49376d71147ebad0667acc044b2789c461ad",
    );
}

#[test]
fn type_assignment_with_a_text_member() {
    let node = Node::Set {
        kind: SetKind::TypeAssignment,
        name: "type-assignment".to_owned(),
        members: vec![Field {
            name: "class".to_owned(),
            value: FieldValue::Text("IfcWallType".to_owned()),
        }],
    };

    let mut expected = header(8); // NodeKind::TypeAssignment
    expected.extend(framed_string("type-assignment"));
    expected.extend(le_u32(1));
    expected.extend(framed_string("class"));
    expected.push(1); // FieldValue::Text tag
    expected.extend(framed_string("IfcWallType"));

    assert_vector(
        &node,
        &expected,
        "blake3:731b71cf1795b37c58854e1cf8974c2950d4cdfdc0e5afde140a19f570c8bbc4",
    );
}

#[test]
fn relationship_with_an_ordered_role() {
    // `IfcRelNests.RelatedObjects` is an ordered `LIST`: targets are written
    // exactly as given, not sorted, and the `ordered` byte is `1`.
    let node = Node::Relationship {
        ifc_type: "IfcRelNests".to_owned(),
        roles: vec![Role {
            name: "RelatedObjects".to_owned(),
            targets: vec![addr(0x22), addr(0x11)], // deliberately descending
            ordered: true,
        }],
    };

    let mut expected = header(4); // NodeKind::Relationship
    expected.extend(framed_string("IfcRelNests"));
    expected.extend(le_u32(1)); // one role
    expected.extend(framed_string("RelatedObjects"));
    expected.push(1); // ordered: true
    expected.extend(le_u32(2)); // two targets
    expected.extend([0x22; 32]); // kept in the given order, not sorted
    expected.extend([0x11; 32]);

    assert_vector(
        &node,
        &expected,
        "blake3:5127f744cb88f94d02389c07cd2d869888404d585370b92e2eadc7d3b395ae07",
    );
}

#[test]
fn geometry_tier_and_digest() {
    let node = Node::Geometry {
        tier: "tessellated".to_owned(),
        digest: "d1".to_owned(),
    };

    let mut expected = header(5); // NodeKind::Geometry
    expected.extend(framed_string("tessellated"));
    expected.extend(framed_string("d1"));

    assert_vector(
        &node,
        &expected,
        "blake3:35c7b082b59552c6a5a16f2995ef92507bcedfeb8d830d3a65ccd98bd594df9d",
    );
}

#[test]
fn name_bag_keeps_duplicates() {
    let node = Node::NameBag {
        kind: "material".to_owned(),
        names: vec!["steel".to_owned(), "steel".to_owned()],
    };

    let mut expected = header(6); // NodeKind::NameBag
    expected.extend(framed_string("material"));
    expected.extend(le_u32(2));
    expected.extend(framed_string("steel"));
    expected.extend(framed_string("steel"));

    assert_vector(
        &node,
        &expected,
        "blake3:bd375a4ae005bafd67ae02246fda0bbeaae9872a4c84526759a9a50a970f045c",
    );
}

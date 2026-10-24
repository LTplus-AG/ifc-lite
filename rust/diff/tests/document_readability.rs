// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//! PR #8104: the bridge must advertise the same mode in both directions.
use ifc_lite_diff::{
    document_serde::{from_document, to_document},
    sidecar_document::parse_ordered_json,
    JsString,
};
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use std::{collections::BTreeMap, net::Ipv4Addr};

// Probe a real value at every visited position, including scalar map keys.
// A mode mismatch fails at the actual nested serializer/deserializer boundary.
#[derive(Debug, PartialEq, Eq, PartialOrd, Ord)]
struct Probe(u32);
impl Serialize for Probe {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        assert!(
            !s.is_human_readable(),
            "document serializer changed mode in a nested position"
        );
        self.0.serialize(s)
    }
}
impl<'de> Deserialize<'de> for Probe {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        assert!(
            !d.is_human_readable(),
            "document deserializer changed mode in a nested position"
        );
        u32::deserialize(d).map(Probe)
    }
}
#[derive(Debug, PartialEq, Serialize, Deserialize)]
struct Wrapped<T>(T);
#[derive(Debug, PartialEq, Serialize, Deserialize)]
enum Branch {
    Newtype(Probe),
    Tuple(Probe, Option<Probe>),
    Struct { value: Wrapped<Probe> },
}
#[derive(Debug, PartialEq, Serialize, Deserialize)]
struct Nested {
    direct: Probe,
    sequence: Vec<Probe>,
    tuple: (Probe, Probe),
    option: Option<Wrapped<Probe>>,
    map: BTreeMap<Probe, Wrapped<Probe>>,
    branches: Vec<Branch>,
    strings: BTreeMap<JsString, Wrapped<JsString>>,
}
#[test]
fn pr_8104_readability_agrees_at_root_and_inside_every_container() {
    let root = Probe(1);
    assert_eq!(
        from_document::<Probe>(to_document(&root).unwrap()).unwrap(),
        root
    );
    let lone = JsString::from_units(vec![0x61, 0xd800, 0xdc00, 0xdc00]);
    let value = Nested {
        direct: Probe(1),
        sequence: vec![Probe(2), Probe(3)],
        tuple: (Probe(4), Probe(5)),
        option: Some(Wrapped(Probe(6))),
        map: BTreeMap::from([(Probe(7), Wrapped(Probe(8)))]),
        branches: vec![
            Branch::Newtype(Probe(9)),
            Branch::Tuple(Probe(10), Some(Probe(11))),
            Branch::Struct {
                value: Wrapped(Probe(12)),
            },
        ],
        strings: BTreeMap::from([(lone.clone(), Wrapped(lone))]),
    };
    assert_eq!(
        from_document::<Nested>(to_document(&value).unwrap()).unwrap(),
        value
    );
}

#[test]
fn pr_8104_ipv4_addresses_round_trip_in_the_existing_non_human_readable_mode() {
    let address = Ipv4Addr::new(192, 0, 2, 7);
    let doc = to_document(address).unwrap();
    // Preserve the existing serializer's tuple representation; the old default
    // `true` on deserialization instead requested a dotted string and failed.
    assert_eq!(doc, parse_ordered_json("[192,0,2,7]").unwrap());
    assert_eq!(from_document::<Ipv4Addr>(doc).unwrap(), address);
    let nested = BTreeMap::from([(
        "address".to_owned(),
        Some(vec![address, Ipv4Addr::LOCALHOST]),
    )]);
    assert_eq!(
        from_document::<BTreeMap<String, Option<Vec<Ipv4Addr>>>>(to_document(&nested).unwrap())
            .unwrap(),
        nested
    );
}

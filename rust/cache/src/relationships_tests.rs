// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use super::*;

fn rel(rel_type: &str, rel_id: u32, relating_id: u32, related_id: u32) -> Relationship {
    Relationship { rel_type: rel_type.to_owned(), rel_id, relating_id, related_id }
}

struct Reader<'a>(&'a [u8], usize);

impl Reader<'_> {
    fn u32(&mut self) -> u32 {
        let value = u32::from_le_bytes(self.0[self.1..self.1 + 4].try_into().unwrap());
        self.1 += 4;
        value
    }
    fn u16(&mut self) -> u16 {
        let value = u16::from_le_bytes(self.0[self.1..self.1 + 2].try_into().unwrap());
        self.1 += 2;
        value
    }
}

#[test]
fn nests_records_the_aggregates_bucket_and_its_own_kind() {
    // #4205: IfcRelNests is folded into Aggregates (2) and also kept as Nests (3).
    let bytes = write_relationships(&[rel("IFCRELNESTS", 9, 1, 2)]);
    let mut r = Reader(&bytes, 0);
    assert_eq!(r.u32(), 1, "one forward node");
    assert_eq!([r.u32(), r.u32(), r.u32()], [1, 0, 2]);
    assert_eq!(r.u32(), 2, "two edges");
    assert_eq!([r.u32(), r.u32()], [2, 2]);
    assert_eq!([r.u16(), r.u16()], [2, 3]);
    assert_eq!([r.u32(), r.u32()], [9, 9]);
    assert_eq!([r.u32(), r.u32(), r.u32()], [0, 0, 0], "empty shadow trailer");
}

#[test]
fn a_repeated_edge_is_shadowed_not_dropped() {
    // #3782: a second IfcRel* naming the same pair keeps its id on the survivor.
    let rows = [
        rel("IFCRELAGGREGATES", 5, 1, 2),
        rel("IFCRELAGGREGATES", 6, 1, 2),
        rel("TYPEHASPROPERTYSETS", 0, 7, 8),
    ];
    let bytes = write_relationships(&rows);
    let mut r = Reader(&bytes, 0);
    assert_eq!(r.u32(), 1, "the synthetic row adds no node");
    r.1 += 12;
    assert_eq!(r.u32(), 1, "the duplicate folds into one edge");
    r.1 += 4 + 2 + 4;
    assert_eq!(r.u32(), 1, "one shadow group");
    assert_eq!(r.u32(), 0, "on edge 0");
    assert_eq!([r.u32(), r.u32()], [0, 1]);
    assert_eq!(r.u32(), 1);
    assert_eq!(r.u32(), 6);
}

#[test]
fn csr_nodes_are_ascending_and_edges_keep_insertion_order_per_node() {
    let rows = [
        rel("IFCRELCONTAINEDINSPATIALSTRUCTURE", 20, 9, 3),
        rel("IFCRELCONTAINEDINSPATIALSTRUCTURE", 20, 9, 1),
        rel("IFCRELAGGREGATES", 21, 4, 9),
    ];
    let bytes = write_relationships(&rows);
    let mut r = Reader(&bytes, 0);
    assert_eq!(r.u32(), 2);
    assert_eq!([r.u32(), r.u32(), r.u32()], [4, 0, 1]);
    assert_eq!([r.u32(), r.u32(), r.u32()], [9, 1, 2]);
    assert_eq!(r.u32(), 3);
    assert_eq!([r.u32(), r.u32(), r.u32()], [9, 3, 1]);
}

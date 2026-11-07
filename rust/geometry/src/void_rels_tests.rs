// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use super::*;
use crate::{propagate_voids_to_parts, VoidIndex};

fn ifc(data: &str) -> String {
    format!(
        "ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION((''),'2;1');\n\
         FILE_NAME('t.ifc','2024-01-01T00:00:00',(''),(''),'','','');\n\
         FILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\n{data}ENDSEC;\nEND-ISO-10303-21;\n"
    )
}

const SHAPE: &str = "#51=IFCPRODUCTDEFINITIONSHAPE($,$,(#50));\n\
#50=IFCSHAPEREPRESENTATION($,'Body','SweptSolid',(#40));\n\
#40=IFCEXTRUDEDAREASOLID($,$,$,3.0);\n";

/// Wall #100 with two openings written in descending id order, aggregating
/// part #101 as a list and part #102 through a bare reference.
fn wall_with_bare_and_list_aggregates() -> String {
    ifc(&format!(
        "{SHAPE}#100=IFCWALL('0001wall',$,'W',$,$,$,#51,$,$);\n\
         #101=IFCBUILDINGELEMENTPART('0001p01',$,'L0',$,$,$,#51,$,$);\n\
         #102=IFCBUILDINGELEMENTPART('0001p02',$,'L1',$,$,$,#51,$,$);\n\
         #201=IFCOPENINGELEMENT('0001o2',$,$,$,$,$,#51,$,$);\n\
         #200=IFCOPENINGELEMENT('0001o1',$,$,$,$,$,#51,$,$);\n\
         #211=IFCRELVOIDSELEMENT('0001v2',$,$,$,#100,#201);\n\
         #210=IFCRELVOIDSELEMENT('0001v1',$,$,$,#100,#200);\n\
         #300=IFCRELAGGREGATES('0001a1',$,$,$,#100,(#101));\n\
         #301=IFCRELAGGREGATES('0001a2',$,$,$,#100,#102);\n"
    ))
}

#[test]
fn production_index_sorts_openings_and_reads_bare_aggregates() {
    let content = wall_with_bare_and_list_aggregates();
    let mut decoder = EntityDecoder::new(&content);
    let index = void_index_from_content(&content, &mut decoder);
    for host in [100, 101, 102] {
        assert_eq!(index.get(&host), Some(&vec![200, 201]), "host #{host}");
    }
    assert_eq!(index.len(), 3);
}

#[test]
fn aggregate_fold_reads_bare_and_list_children_and_skips_empty() {
    let content = ifc("#300=IFCRELAGGREGATES('a',$,$,$,#1,(#2,#3));\n\
         #301=IFCRELAGGREGATES('b',$,$,$,#1,#4);\n\
         #302=IFCRELAGGREGATES('c',$,$,$,#5,());\n\
         #303=IFCRELAGGREGATES('d',$,$,$,$,(#6));\n");
    let mut decoder = EntityDecoder::new(&content);
    let (_, spans) = scan_rel_spans(content.as_bytes(), false, true);
    let children = fold_aggregate_rels(&spans, &mut decoder);
    assert_eq!(children.get(&1), Some(&vec![2, 3, 4]));
    assert_eq!(
        children.len(),
        1,
        "empty and parentless relationships add nothing"
    );
}

#[test]
fn void_index_keeps_file_order_through_the_shared_fold() {
    let content = wall_with_bare_and_list_aggregates();
    let mut decoder = EntityDecoder::new(&content);
    let index = VoidIndex::from_content(&content, &mut decoder);
    // Standalone VoidIndex is unchanged: direct relationships, file order.
    assert_eq!(index.get_voids(100), &[201, 200]);
    assert!(index.get_voids(101).is_empty());
    assert_eq!(index.get_host(200), Some(100));
    assert_eq!(index.total_relationships(), 2);
}

#[test]
fn propagate_voids_to_parts_follows_bare_aggregates_8341() {
    // C4-15 behaviour change: the standalone aggregate fold used to read
    // RelatedObjects list-only and dropped the bare `#102`; it now shares the
    // production prepass's bare-tolerant fold.
    let content = wall_with_bare_and_list_aggregates();
    let mut decoder = EntityDecoder::new(&content);
    let mut void_index: FxHashMap<u32, Vec<u32>> = FxHashMap::default();
    void_index.insert(100, vec![200]);
    let part_to_parent = propagate_voids_to_parts(&mut void_index, &content, &mut decoder);
    assert_eq!(part_to_parent.get(&101), Some(&100));
    assert_eq!(part_to_parent.get(&102), Some(&100));
    assert_eq!(void_index.get(&102), Some(&vec![200]));
}

#[test]
fn keywords_match_in_any_case() {
    let content = ifc("#210=IfcRelVoidsElement('v',$,$,$,#100,#200);\n");
    let mut decoder = EntityDecoder::new(&content);
    let index = void_index_from_content(&content, &mut decoder);
    assert_eq!(index.get(&100), Some(&vec![200]));
}

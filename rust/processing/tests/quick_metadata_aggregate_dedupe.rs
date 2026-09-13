// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Split out of #4590. An `IfcRelAggregates` naming a spatial child k times per
//! level, or under a second parent, must still put each node in the bootstrap
//! tree exactly once (it came out k^depth times), and a back-edge listed before
//! the real parent (the #4246 shape) must not cut the branch off the project.

use ifc_lite_processing::determinism::FIXTURE_IFC;
use ifc_lite_processing::{
    process_geometry_streaming_with_options_and_bootstrap, QuickMetadataSpatialNode,
    StreamingOptions,
};

/// The determinism fixture carries no spatial tree; append one whose
/// `IfcRelAggregates` list each child three times at every level, plus a
/// back-edge (building aggregates site) before the project places the site,
/// and a later relationship that names the storey under the site as well.
fn fixture_with_duplicated_aggregates() -> String {
    const TREE: &str = "\
#900=IFCSITE('0DeterminismSite0000A',$,'Site',$,$,#20,$,$,.ELEMENT.,$,$,$,$,$);
#901=IFCBUILDING('0DeterminismBldg0000A',$,'Building',$,$,#20,$,$,.ELEMENT.,$,$,$);
#902=IFCBUILDINGSTOREY('0DeterminismStorey00A',$,'Level 1',$,$,#20,$,$,.ELEMENT.,0.);
#909=IFCRELAGGREGATES('0DeterminismAggBack00A',$,$,$,#901,(#900));
#910=IFCRELAGGREGATES('0DeterminismAggPS000A',$,$,$,#1,(#900,#900,#900));
#911=IFCRELAGGREGATES('0DeterminismAggSB000A',$,$,$,#900,(#901,#901,#901));
#912=IFCRELAGGREGATES('0DeterminismAggBS000A',$,$,$,#901,(#902,#902,#902));
#913=IFCRELAGGREGATES('0DeterminismAggSS000A',$,$,$,#900,(#902));
#914=IFCRELCONTAINEDINSPATIALSTRUCTURE('0DeterminismCont000A',$,$,$,(#100,#400,#500,#600),#902);
";
    FIXTURE_IFC.replacen("ENDSEC;\nEND-ISO", &format!("{TREE}ENDSEC;\nEND-ISO"), 1)
}

fn bootstrap_tree(ifc: &str) -> QuickMetadataSpatialNode {
    let mut bootstrap = None;
    process_geometry_streaming_with_options_and_bootstrap(
        ifc.as_bytes(),
        StreamingOptions {
            emit_quick_metadata_bootstrap: true,
            ..StreamingOptions::default()
        },
        |_, _, _| {},
        |_| {},
        |b| bootstrap = Some(b.clone()),
    );
    bootstrap
        .expect("quick metadata bootstrap was requested")
        .spatial_tree
        .expect("the fixture has an IfcProject root, so a spatial tree is built")
}

fn count(node: &QuickMetadataSpatialNode, id: u32) -> usize {
    usize::from(node.summary.express_id == id)
        + node.children.iter().map(|c| count(c, id)).sum::<usize>()
}

fn child(node: &QuickMetadataSpatialNode, id: u32) -> Option<&QuickMetadataSpatialNode> {
    node.children.iter().find(|c| c.summary.express_id == id)
}

#[test]
fn duplicated_aggregate_children_are_placed_once() {
    let root = bootstrap_tree(&fixture_with_duplicated_aggregates());
    assert_eq!(root.summary.express_id, 1, "IfcProject #1 is the root");
    for id in [900, 901, 902] {
        assert_eq!(
            count(&root, id),
            1,
            "node #{id} must be placed exactly once"
        );
    }
    // The walk from the project reaches the site, then the building (listed
    // before #913), so the storey stays under the building and its contained
    // elements ride on that single node.
    let site = child(&root, 900).expect("site #900 stays under the project");
    let building = child(site, 901).expect("building #901 stays under site #900");
    let storey = child(building, 902).expect("storey #902 stays under building #901");
    assert_eq!(
        storey.elements.len(),
        4,
        "storey #902 keeps its four contained elements"
    );
}

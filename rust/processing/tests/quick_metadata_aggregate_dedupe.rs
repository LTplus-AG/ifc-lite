// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Split out of #4590. An `IfcRelAggregates` naming a spatial child k times per
//! level, or under a second parent, must still put each node in the bootstrap
//! tree exactly once (it came out k^depth times), and a back-edge listed before
//! the real parent (the #4246 shape) must not cut the branch off the project.
//! Every edge left out of the tree is reported on the bootstrap with its parent
//! and child ids and its kind (#4662).

use ifc_lite_processing::determinism::FIXTURE_IFC;
use ifc_lite_processing::QuickMetadataPrunedEdgeKind::{BackEdge, SecondParent, SiblingRepeat};
use ifc_lite_processing::{
    process_geometry_streaming_with_options_and_bootstrap, QuickMetadataBootstrap,
    QuickMetadataPrunedEdge, QuickMetadataSpatialNode, StreamingOptions,
};

/// Site, building and storey, with the storey containing four elements.
const SPATIAL_ENTITIES: &str = "\
#900=IFCSITE('0DeterminismSite0000A',$,'Site',$,$,#20,$,$,.ELEMENT.,$,$,$,$,$);
#901=IFCBUILDING('0DeterminismBldg0000A',$,'Building',$,$,#20,$,$,.ELEMENT.,$,$,$);
#902=IFCBUILDINGSTOREY('0DeterminismStorey00A',$,'Level 1',$,$,#20,$,$,.ELEMENT.,0.);
#914=IFCRELCONTAINEDINSPATIALSTRUCTURE('0DeterminismCont000A',$,$,$,(#100,#400,#500,#600),#902);
";

/// Each child listed three times at every level, plus a back-edge (building
/// aggregates site) before the project places the site, and a later
/// relationship that names the storey under the site as well.
const DUPLICATED_AGGREGATES: &str = "\
#909=IFCRELAGGREGATES('0DeterminismAggBack00A',$,$,$,#901,(#900));
#910=IFCRELAGGREGATES('0DeterminismAggPS000A',$,$,$,#1,(#900,#900,#900));
#911=IFCRELAGGREGATES('0DeterminismAggSB000A',$,$,$,#900,(#901,#901,#901));
#912=IFCRELAGGREGATES('0DeterminismAggBS000A',$,$,$,#901,(#902,#902,#902));
#913=IFCRELAGGREGATES('0DeterminismAggSS000A',$,$,$,#900,(#902));
";

/// The same hierarchy with each edge named once.
const CLEAN_AGGREGATES: &str = "\
#910=IFCRELAGGREGATES('0DeterminismAggPS000A',$,$,$,#1,(#900));
#911=IFCRELAGGREGATES('0DeterminismAggSB000A',$,$,$,#900,(#901));
#912=IFCRELAGGREGATES('0DeterminismAggBS000A',$,$,$,#901,(#902));
";

/// The determinism fixture carries no spatial tree; append one.
fn fixture_with(aggregates: &str) -> String {
    FIXTURE_IFC.replacen(
        "ENDSEC;\nEND-ISO",
        &format!("{SPATIAL_ENTITIES}{aggregates}ENDSEC;\nEND-ISO"),
        1,
    )
}

fn bootstrap(ifc: &str) -> QuickMetadataBootstrap {
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
    bootstrap.expect("quick metadata bootstrap was requested")
}

fn tree(bootstrap: &QuickMetadataBootstrap) -> &QuickMetadataSpatialNode {
    bootstrap
        .spatial_tree
        .as_ref()
        .expect("the fixture has an IfcProject root, so a spatial tree is built")
}

fn count(node: &QuickMetadataSpatialNode, id: u32) -> usize {
    usize::from(node.summary.express_id == id)
        + node.children.iter().map(|c| count(c, id)).sum::<usize>()
}

fn child(node: &QuickMetadataSpatialNode, id: u32) -> Option<&QuickMetadataSpatialNode> {
    node.children.iter().find(|c| c.summary.express_id == id)
}

/// Project, site, building and storey each placed once, in that chain.
fn assert_single_chain(root: &QuickMetadataSpatialNode) {
    assert_eq!(root.summary.express_id, 1, "IfcProject #1 is the root");
    for id in [900, 901, 902] {
        assert_eq!(
            count(root, id),
            1,
            "node #{id} must be placed exactly once"
        );
    }
    let site = child(root, 900).expect("site #900 stays under the project");
    let building = child(site, 901).expect("building #901 stays under site #900");
    let storey = child(building, 902).expect("storey #902 stays under building #901");
    assert_eq!(
        storey.elements.len(),
        4,
        "storey #902 keeps its four contained elements"
    );
}

#[test]
fn duplicated_aggregate_children_are_placed_once() {
    // The walk from the project reaches the site, then the building (listed
    // before #913), so the storey stays under the building and its contained
    // elements ride on that single node.
    assert_single_chain(tree(&bootstrap(&fixture_with(DUPLICATED_AGGREGATES))));
}

#[test]
fn pruned_aggregate_edges_are_reported_with_their_ids() {
    let bootstrap = bootstrap(&fixture_with(DUPLICATED_AGGREGATES));
    let edge = |parent_express_id, child_express_id, kind| QuickMetadataPrunedEdge {
        parent_express_id,
        child_express_id,
        kind,
    };
    // In walk order: inside the building, #909 names the site that is still
    // being built (back-edge) and #912 repeats the storey twice; back in the
    // site, #911 repeats the building twice and #913 names the storey the
    // building already placed (second parent); back in the project, #910
    // repeats the site twice.
    assert_eq!(
        bootstrap.pruned_aggregate_edges,
        [
            edge(901, 900, BackEdge),
            edge(901, 902, SiblingRepeat),
            edge(901, 902, SiblingRepeat),
            edge(900, 901, SiblingRepeat),
            edge(900, 901, SiblingRepeat),
            edge(900, 902, SecondParent),
            edge(1, 900, SiblingRepeat),
            edge(1, 900, SiblingRepeat),
        ]
    );
    let json = serde_json::to_value(&bootstrap).expect("bootstrap serialises");
    assert_eq!(
        json["pruned_aggregate_edges"][0],
        serde_json::json!({ "parent_express_id": 901, "child_express_id": 900, "kind": "back_edge" })
    );
}

#[test]
fn clean_aggregate_tree_reports_no_pruned_edges() {
    let bootstrap = bootstrap(&fixture_with(CLEAN_AGGREGATES));
    // Anti-vacuity: the walk really crossed three aggregate edges.
    assert_single_chain(tree(&bootstrap));
    assert!(
        bootstrap.pruned_aggregate_edges.is_empty(),
        "a clean hierarchy prunes nothing, got {:?}",
        bootstrap.pruned_aggregate_edges
    );
    // An empty list stays off the wire, and a payload written before the
    // field existed still reads.
    let json = serde_json::to_value(&bootstrap).expect("bootstrap serialises");
    assert!(json.get("pruned_aggregate_edges").is_none(), "{json}");
    let old: QuickMetadataBootstrap =
        serde_json::from_value(json).expect("a payload without the field deserialises");
    assert!(old.pruned_aggregate_edges.is_empty());
}

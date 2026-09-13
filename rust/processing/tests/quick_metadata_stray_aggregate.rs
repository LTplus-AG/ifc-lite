// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! #4689: a stray `IfcRelAggregates` edge must not decide where a spatial node
//! goes. The containment wiring used to skip a space whose `parent` any
//! aggregate had set, and the no-project root fallback picked only nodes no
//! edge named, so an edge from a node the walk never reaches (an orphan
//! building, or a back-edge from the space's own child) could remove a
//! contained space from the tree, or remove the whole tree.

mod common;

use common::quick_metadata::{bootstrap, child, count, tree};
use ifc_lite_processing::QuickMetadataSpatialNode;

const HEADER: &str = "ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('issue-4689 stray aggregate fixture'),'2;1');
FILE_NAME('stray.ifc','2026-09-13T00:00:00',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#2=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.0E-5,#5,$);
#3=IFCUNITASSIGNMENT((#6));
#4=IFCCARTESIANPOINT((0.,0.,0.));
#5=IFCAXIS2PLACEMENT3D(#4,$,$);
#6=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#20=IFCSITE('4689Site00000000000001',$,'Site',$,$,$,$,$,.ELEMENT.,$,$,$,$,$);
#21=IFCBUILDING('4689Building0000000001',$,'Building',$,$,$,$,$,.ELEMENT.,$,$,$);
#22=IFCBUILDINGSTOREY('4689Storey00000000001',$,'Level 1',$,$,$,$,$,.ELEMENT.,0.);
#31=IFCSPACE('4689Space000000000001',$,'Room',$,$,$,$,$,.ELEMENT.,.INTERNAL.,$);
#51=IFCRELAGGREGATES('4689AggSiteBldg000001',$,$,$,#20,(#21));
#52=IFCRELAGGREGATES('4689AggBldgStorey00001',$,$,$,#21,(#22));
";

const PROJECT: &str = "\
#1=IFCPROJECT('4689Project0000000001',$,'P',$,$,$,$,(#2),#3);
#50=IFCRELAGGREGATES('4689AggProjSite000001',$,$,$,#1,(#20));
";

/// Storey #22 contains space #31.
const CONTAINMENT: &str = "\
#40=IFCRELCONTAINEDINSPATIALSTRUCTURE('4689ContStorey0000001',$,$,$,(#31),#22);
";

fn file(parts: &[&str]) -> String {
    format!("{HEADER}{}ENDSEC;\nEND-ISO-10303-21;\n", parts.concat())
}

/// Site, building and storey under `root`, returning the storey.
fn storey_under(root: &QuickMetadataSpatialNode) -> &QuickMetadataSpatialNode {
    child(child(child(root, 20), 21), 22)
}

#[test]
fn contained_space_also_named_by_an_orphan_aggregate_stays_under_its_storey() {
    // Building #80 is aggregated by nothing, so the walk from the project never
    // reaches it; its aggregate of #31 used to set #31's parent and make the
    // containment wiring skip the storey edge.
    const ORPHAN: &str = "\
#80=IFCBUILDING('4689Orphan00000000001',$,'Orphan',$,$,$,$,$,.ELEMENT.,$,$,$);
#90=IFCRELAGGREGATES('4689AggOrphanSpace0001',$,$,$,#80,(#31));
";
    let bootstrap = bootstrap(&file(&[PROJECT, CONTAINMENT, ORPHAN]));
    let root = tree(&bootstrap);
    assert_eq!(root.summary.express_id, 1);
    let space = child(storey_under(root), 31);
    assert_eq!(space.summary.type_name.to_ascii_uppercase(), "IFCSPACE");
    assert_eq!(count(root, 31), 1, "space #31 is placed exactly once");
}

#[test]
fn contained_space_with_a_back_edge_from_its_own_child_stays_under_its_storey() {
    // #31 aggregates sub-space #32, and #32 names #31 back. The back-edge set
    // #31's parent to #32, which is reachable only through #31, so both left
    // the tree.
    const BACK_EDGE: &str = "\
#32=IFCSPACE('4689SubSpace000000001',$,'Alcove',$,$,$,$,$,.ELEMENT.,.INTERNAL.,$);
#91=IFCRELAGGREGATES('4689AggSpaceSub000001',$,$,$,#31,(#32));
#92=IFCRELAGGREGATES('4689AggSubBack0000001',$,$,$,#32,(#31));
";
    let bootstrap = bootstrap(&file(&[PROJECT, CONTAINMENT, BACK_EDGE]));
    let root = tree(&bootstrap);
    let space = child(storey_under(root), 31);
    child(space, 32);
    assert_eq!((count(root, 31), count(root, 32)), (1, 1));
}

#[test]
fn without_a_project_a_back_edge_to_the_top_node_still_yields_a_tree() {
    // No IfcProject, and storey #22 names site #20 back, so every node is some
    // edge's child. The fallback used to require a node no edge names and
    // emitted no tree at all.
    const BACK_TO_SITE: &str = "\
#93=IFCRELAGGREGATES('4689AggStoreySite00001',$,$,$,#22,(#20));
";
    let bootstrap = bootstrap(&file(&[CONTAINMENT, BACK_TO_SITE]));
    assert!(
        bootstrap.spatial_tree.is_some(),
        "a file with spatial nodes and no IfcProject still builds a tree"
    );
    let root = tree(&bootstrap);
    assert_eq!(root.summary.express_id, 20, "the lowest id heads the tree");
    let storey = child(child(root, 21), 22);
    child(storey, 31);
}

#[test]
fn without_a_project_the_unnamed_node_is_still_preferred_as_root() {
    // Control for the fallback: when some node is no edge's child, it heads
    // the tree even though a lower id exists below it.
    const LOW_ID_SPACE: &str = "\
#9=IFCSPACE('4689LowIdSpace0000001',$,'Low',$,$,$,$,$,.ELEMENT.,.INTERNAL.,$);
#94=IFCRELCONTAINEDINSPATIALSTRUCTURE('4689ContLowId00000001',$,$,$,(#9),#22);
";
    let bootstrap = bootstrap(&file(&[CONTAINMENT, LOW_ID_SPACE]));
    let root = tree(&bootstrap);
    assert_eq!(
        root.summary.express_id, 20,
        "site #20 is the only unnamed node"
    );
    let storey = child(child(root, 21), 22);
    child(storey, 9);
    child(storey, 31);
}

#[test]
fn space_both_aggregated_and_contained_by_its_storey_reports_no_pruned_edge() {
    // A well-formed file may relate a space to its storey both ways. The
    // containment is not an IfcRelAggregates edge, so the tree walk skipping
    // it is not a pruned aggregate edge.
    const BOTH: &str = "\
#53=IFCRELAGGREGATES('4689AggStoreySpace0001',$,$,$,#22,(#31));
";
    let bootstrap = bootstrap(&file(&[PROJECT, BOTH, CONTAINMENT]));
    let root = tree(&bootstrap);
    child(storey_under(root), 31);
    assert_eq!(count(root, 31), 1);
    assert!(
        bootstrap.pruned_aggregate_edges.is_empty(),
        "{:?}",
        bootstrap.pruned_aggregate_edges
    );
}

#[test]
fn aggregate_placement_wins_over_an_earlier_containment() {
    // Storey #22 (walked first) contains #31, and storey #23 aggregates it. The
    // aggregate is the relationship IFC defines for a space, so #31 goes under
    // #23 whichever storey the walk reaches first.
    const TWO_STOREYS: &str = "\
#23=IFCBUILDINGSTOREY('4689Storey00000000002',$,'Level 2',$,$,$,$,$,.ELEMENT.,3.);
#54=IFCRELAGGREGATES('4689AggBldgStorey00002',$,$,$,#21,(#23));
#55=IFCRELAGGREGATES('4689AggStorey2Space001',$,$,$,#23,(#31));
";
    let bootstrap = bootstrap(&file(&[PROJECT, CONTAINMENT, TWO_STOREYS]));
    let root = tree(&bootstrap);
    let building = child(child(root, 20), 21);
    child(child(building, 23), 31);
    assert_eq!(count(root, 31), 1, "space #31 is placed exactly once");
    assert!(
        bootstrap.pruned_aggregate_edges.is_empty(),
        "{:?}",
        bootstrap.pruned_aggregate_edges
    );
}

#[test]
fn space_contained_by_two_storeys_reports_no_pruned_edge() {
    // No aggregate names #31, so neither containment is an aggregate edge; the
    // first one the walk reaches places it and the second is not reported.
    const SECOND_CONTAINMENT: &str = "\
#23=IFCBUILDINGSTOREY('4689Storey00000000002',$,'Level 2',$,$,$,$,$,.ELEMENT.,3.);
#54=IFCRELAGGREGATES('4689AggBldgStorey00002',$,$,$,#21,(#23));
#56=IFCRELCONTAINEDINSPATIALSTRUCTURE('4689ContStorey0000002',$,$,$,(#31),#23);
";
    let bootstrap = bootstrap(&file(&[PROJECT, CONTAINMENT, SECOND_CONTAINMENT]));
    let root = tree(&bootstrap);
    child(storey_under(root), 31);
    assert_eq!(count(root, 31), 1, "space #31 is placed exactly once");
    assert!(
        bootstrap.pruned_aggregate_edges.is_empty(),
        "{:?}",
        bootstrap.pruned_aggregate_edges
    );
}

#[test]
fn aggregate_from_a_contained_parent_wins_over_an_earlier_containment() {
    // Storey #22 contains sub-space #32 before space #31, and #31 (itself
    // placed only by containment, and named by no aggregate) aggregates #32.
    // The aggregate still places #32, though the containment lists it first.
    const SUB_SPACE: &str = "\
#32=IFCSPACE('4689SubSpace000000001',$,'Alcove',$,$,$,$,$,.ELEMENT.,.INTERNAL.,$);
#57=IFCRELCONTAINEDINSPATIALSTRUCTURE('4689ContStoreySub00001',$,$,$,(#32,#31),#22);
#91=IFCRELAGGREGATES('4689AggSpaceSub000001',$,$,$,#31,(#32));
";
    let bootstrap = bootstrap(&file(&[PROJECT, SUB_SPACE]));
    let root = tree(&bootstrap);
    child(child(storey_under(root), 31), 32);
    assert_eq!(count(root, 32), 1, "sub-space #32 is placed exactly once");
    assert!(
        bootstrap.pruned_aggregate_edges.is_empty(),
        "{:?}",
        bootstrap.pruned_aggregate_edges
    );
}

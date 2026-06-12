// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Issue #1075 — IfcSpatialZone rendering + Family/Dynamo spatial containment.
//!
//! Two regressions are locked here end-to-end through `process_geometry`:
//!
//! 1. **IfcSpatialZone geometry.** A zone carrying a body (Revit Family geometry
//!    authored via Dynamo, common in Dutch GFA/permitting models) was blocked
//!    from meshing by `is_non_geometric_spatial`. It must now mesh like IfcSpace.
//!
//! 2. **Contained-in spatial nodes.** IfcSpace / IfcSpatialZone attached to a
//!    storey via `IfcRelContainedInSpatialStructure` (instead of
//!    `IfcRelAggregates`) used to land in the storey's flat element list and
//!    vanish from the quick-bootstrap spatial tree. They must be promoted to
//!    spatial child nodes alongside aggregated spaces.

use ifc_lite_processing::{
    process_geometry, process_geometry_streaming_with_options_and_bootstrap, QuickMetadataBootstrap,
    StreamingOptions,
};

const ZONES_IFC: &str = r#"ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('issue-1075 spatial zone fixture'),'2;1');
FILE_NAME('zones.ifc','2026-06-12T00:00:00',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('1Project00000000001075',$,'P',$,$,$,$,(#2),#3);
#2=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.0E-5,#5,$);
#3=IFCUNITASSIGNMENT((#6));
#4=IFCCARTESIANPOINT((0.,0.,0.));
#5=IFCAXIS2PLACEMENT3D(#4,$,$);
#6=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#7=IFCLOCALPLACEMENT($,#5);
#8=IFCCARTESIANPOINTLIST3D(((0.,0.,0.),(1.,0.,0.),(0.,1.,0.),(0.,0.,1.)));

#20=IFCSITE('1Site0000000000001075',$,'Site',$,$,#7,$,$,.ELEMENT.,$,$,$,$,$);
#21=IFCBUILDING('1Building000000001075',$,'Building',$,$,#7,$,$,.ELEMENT.,$,$,$);
#22=IFCBUILDINGSTOREY('1Storey0000000001075',$,'Level 1',$,$,#7,$,$,.ELEMENT.,0.);

#30=IFCSPACE('1SpaceAgg000000001075',$,'Room 101',$,$,$,$,$,.ELEMENT.,.INTERNAL.,$);
#31=IFCSPACE('1SpaceCon000000001075',$,'Family Space',$,$,$,$,$,.ELEMENT.,.INTERNAL.,$);

#40=IFCSPATIALZONE('1Zone000000000001075',$,'GFA Apt',$,$,#7,#41,$,$);
#41=IFCPRODUCTDEFINITIONSHAPE($,$,(#42));
#42=IFCSHAPEREPRESENTATION(#2,'Body','Tessellation',(#43));
#43=IFCTRIANGULATEDFACESET(#8,$,.T.,((1,2,3),(1,2,4),(1,4,3),(2,3,4)),$);

#50=IFCRELAGGREGATES('1RelAggProjSite01075',$,$,$,#1,(#20));
#51=IFCRELAGGREGATES('1RelAggSiteBldg01075',$,$,$,#20,(#21));
#52=IFCRELAGGREGATES('1RelAggBldgStor01075',$,$,$,#21,(#22));
#53=IFCRELAGGREGATES('1RelAggStorSpace1075',$,$,$,#22,(#30));
#54=IFCRELCONTAINEDINSPATIALSTRUCTURE('1RelConStorey001075',$,$,$,(#31,#40),#22);
ENDSEC;
END-ISO-10303-21;
"#;

#[test]
fn spatial_zone_with_a_body_meshes_like_a_space() {
    let result = process_geometry(ZONES_IFC);

    let seen: Vec<(u32, &str)> = result
        .meshes
        .iter()
        .map(|m| (m.express_id, m.ifc_type.as_str()))
        .collect();

    let zone = result
        .meshes
        .iter()
        .find(|m| m.express_id == 40)
        .unwrap_or_else(|| panic!("IfcSpatialZone #40 with a body produced no mesh; got {seen:?}"));

    assert_eq!(
        zone.ifc_type.as_str(),
        "IfcSpatialZone",
        "the meshed entity should be tagged IfcSpatialZone"
    );
}

#[test]
fn contained_spaces_and_zones_become_spatial_tree_nodes() {
    let mut captured: Option<QuickMetadataBootstrap> = None;
    let options = StreamingOptions {
        emit_quick_metadata_bootstrap: true,
        ..Default::default()
    };
    process_geometry_streaming_with_options_and_bootstrap(
        ZONES_IFC.as_bytes(),
        options,
        |_, _, _| {},
        |_| {},
        |b| captured = Some(b.clone()),
    );

    let boot = captured.expect("a quick-metadata bootstrap should be emitted");
    let tree = boot.spatial_tree.expect("a spatial tree should be built");

    // Project -> Site -> Building -> Storey.
    let site = tree.children.first().expect("project has a site child");
    let building = site.children.first().expect("site has a building child");
    let storey = building.children.first().expect("building has a storey child");
    assert!(
        storey.summary.type_name.eq_ignore_ascii_case("IfcBuildingStorey"),
        "expected a storey, got {}",
        storey.summary.type_name
    );

    let mut child_ids: Vec<u32> = storey.children.iter().map(|c| c.summary.express_id).collect();
    child_ids.sort_unstable();
    assert_eq!(
        child_ids,
        vec![30, 31, 40],
        "the storey's spatial children must include the aggregated space (#30), the \
         contained Family space (#31) and the contained IfcSpatialZone (#40)"
    );

    // The contained spatial elements must NOT also appear as flat storey elements.
    let element_ids: Vec<u32> = storey.elements.iter().map(|e| e.express_id).collect();
    assert!(
        !element_ids.contains(&31) && !element_ids.contains(&40),
        "contained spaces/zones leaked into the storey's element list: {element_ids:?}"
    );
}

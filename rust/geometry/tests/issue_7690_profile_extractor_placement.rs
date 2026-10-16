// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! PROC-2 (#7690): the 2D drawing extractor (`extract_profiles`) used to carry
//! its own placement walk and its own `IfcExtrudedAreaSolid` attribute decoding,
//! and both had drifted from the mesh path:
//!
//! - an `IfcGridPlacement` (or `IfcLinearPlacement`) resolved to the identity,
//!   so the drawing put a grid-placed column at the origin while the 3D mesh
//!   stood at its grid intersection;
//! - a missing `Depth` became 1.0 and a zero-length or non-`IfcDirection`
//!   `ExtrudedDirection` became +Z, where `ExtrudedAreaSolidProcessor` refuses
//!   the solid;
//! - a mapped item dropped for an unresolvable source or representation left
//!   no `SkippedProfile`.
//!
//! The oracle is the mesh path itself (`GeometryRouter::resolve_scaled_placement`).

use ifc_lite_core::EntityDecoder;
use ifc_lite_geometry::{extract_profiles_with_diagnostics, GeometryRouter};

fn ifc(schema: &str, data: &str) -> String {
    format!(
        "ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION((''),'2;1');\nFILE_NAME('','',(''),(''),'','','');\n\
         FILE_SCHEMA(('{schema}'));\nENDSEC;\nDATA;\n{data}ENDSEC;\nEND-ISO-10303-21;\n"
    )
}

/// A grid of axes P (along X) and Q (along Y) meeting at the origin, a local
/// frame at (100, 200, 300), and two columns: #60 on the P/Q intersection
/// relative to that frame, #61 on the intersection offset by (2, 3, 4).
const GRID: &str = "#1=IFCCARTESIANPOINT((0.,0.));#2=IFCCARTESIANPOINT((10.,0.));\n\
#3=IFCPOLYLINE((#1,#2));#4=IFCGRIDAXIS('P',#3,.T.);#5=IFCCARTESIANPOINT((0.,10.));\n\
#6=IFCPOLYLINE((#1,#5));#7=IFCGRIDAXIS('Q',#6,.T.);\n\
#8=IFCVIRTUALGRIDINTERSECTION((#4,#7),(0.,0.,0.));#30=IFCVIRTUALGRIDINTERSECTION((#4,#7),(2.,3.,4.));\n\
#40=IFCDIRECTION((0.,0.,1.));#41=IFCDIRECTION((1.,0.,0.));#42=IFCCARTESIANPOINT((100.,200.,300.));\n\
#43=IFCAXIS2PLACEMENT3D(#42,#40,#41);#44=IFCLOCALPLACEMENT($,#43);\n\
#45=IFCGRIDPLACEMENT(#44,#8,$);#31=IFCGRIDPLACEMENT($,#30,$);\n\
#50=IFCCARTESIANPOINT((0.,0.));#51=IFCAXIS2PLACEMENT2D(#50,$);\n\
#52=IFCRECTANGLEPROFILEDEF(.AREA.,$,#51,0.4,0.4);#53=IFCEXTRUDEDAREASOLID(#52,$,#40,3.);\n\
#54=IFCSHAPEREPRESENTATION($,'Body','SweptSolid',(#53));#55=IFCPRODUCTDEFINITIONSHAPE($,$,(#54));\n\
#60=IFCCOLUMN('0000000000000000000060',$,$,$,$,#45,#55,$,$);\n\
#61=IFCCOLUMN('0000000000000000000061',$,$,$,$,#31,#55,$,$);\n";

/// The mesh path's world translation of `id`, in IFC Z-up metres.
fn mesh_path_translation(content: &str, id: u32) -> [f64; 3] {
    let mut decoder = EntityDecoder::new(content);
    let router = GeometryRouter::with_units(content, &mut decoder);
    let element = decoder.decode_by_id(id).unwrap();
    let m = router.resolve_scaled_placement(&element, &mut decoder).unwrap();
    [m[12], m[13], m[14]]
}

#[test]
fn proc_2_grid_placed_profiles_stand_where_the_mesh_does() {
    let content = ifc("IFC4X3_ADD2", GRID);
    let (profiles, skipped) = extract_profiles_with_diagnostics(&content, 0);
    assert!(skipped.is_empty(), "{skipped:?}");
    for id in [60, 61] {
        let profile = profiles.iter().find(|p| p.express_id == id).expect("one profile per column");
        let mesh = mesh_path_translation(&content, id);
        assert!(mesh.iter().any(|c| c.abs() > 1.0), "the fixture must place #{id} off the origin: {mesh:?}");
        // WebGL Y-up: X = IFC X, Y = IFC Z, Z = -IFC Y.
        let t = &profile.transform;
        let drawn = [t[12], -t[14], t[13]];
        for axis in 0..3 {
            assert!(
                (drawn[axis] - mesh[axis]).abs() < 1e-4,
                "#{id}: the drawing stands at {drawn:?}, the mesh at {mesh:?}"
            );
        }
    }
}

/// One wall per malformed `IfcExtrudedAreaSolid`: #20 has no `Depth`, #21 a
/// zero-length `ExtrudedDirection`, #22 a `ExtrudedDirection` that is not an
/// `IfcDirection`. #23 is well formed, the control.
const BAD_SOLIDS: &str = "#1=IFCCARTESIANPOINT((0.,0.));#2=IFCAXIS2PLACEMENT2D(#1,$);\n\
#3=IFCRECTANGLEPROFILEDEF(.AREA.,$,#2,1.,1.);#4=IFCDIRECTION((0.,0.,1.));#5=IFCDIRECTION((0.,0.,0.));\n\
#6=IFCCARTESIANPOINT((0.,0.,1.));\n\
#10=IFCEXTRUDEDAREASOLID(#3,$,#4,$);#11=IFCEXTRUDEDAREASOLID(#3,$,#5,2.);\n\
#12=IFCEXTRUDEDAREASOLID(#3,$,#6,2.);#13=IFCEXTRUDEDAREASOLID(#3,$,#4,2.);\n\
#30=IFCSHAPEREPRESENTATION($,'Body','SweptSolid',(#10));#31=IFCSHAPEREPRESENTATION($,'Body','SweptSolid',(#11));\n\
#32=IFCSHAPEREPRESENTATION($,'Body','SweptSolid',(#12));#33=IFCSHAPEREPRESENTATION($,'Body','SweptSolid',(#13));\n\
#40=IFCPRODUCTDEFINITIONSHAPE($,$,(#30));#41=IFCPRODUCTDEFINITIONSHAPE($,$,(#31));\n\
#42=IFCPRODUCTDEFINITIONSHAPE($,$,(#32));#43=IFCPRODUCTDEFINITIONSHAPE($,$,(#33));\n\
#20=IFCWALL('0000000000000000000020',$,$,$,$,$,#40,$,$);#21=IFCWALL('0000000000000000000021',$,$,$,$,$,#41,$,$);\n\
#22=IFCWALL('0000000000000000000022',$,$,$,$,$,#42,$,$);#23=IFCWALL('0000000000000000000023',$,$,$,$,$,#43,$,$);\n";

/// The extractor refuses exactly the solids the mesh path refuses, and says so.
#[test]
fn proc_2_a_solid_the_mesh_path_refuses_has_no_drawing_profile() {
    let content = ifc("IFC4", BAD_SOLIDS);
    let (profiles, skipped) = extract_profiles_with_diagnostics(&content, 0);
    let ids: Vec<u32> = profiles.iter().map(|p| p.express_id).collect();
    assert_eq!(ids, [23], "only the well-formed wall is drawn; skipped: {skipped:?}");
    let mut skipped_ids: Vec<u32> = skipped.iter().map(|s| s.express_id).collect();
    skipped_ids.sort_unstable();
    assert_eq!(skipped_ids, [20, 21, 22], "{skipped:?}");

    let mut decoder = EntityDecoder::new(&content);
    let router = GeometryRouter::with_units(&content, &mut decoder);
    for id in [20, 21, 22] {
        let wall = decoder.decode_by_id(id).unwrap();
        let mesh = router.process_element(&wall, &mut decoder);
        assert!(!matches!(mesh, Ok(m) if !m.is_empty()), "#{id}: the mesh path must refuse it too");
    }
}

/// Wall #20 maps a dangling source; wall #21 maps a source whose
/// representation dangles. Neither is drawn, and both are reported.
const BAD_MAPS: &str = "#1=IFCCARTESIANPOINT((0.,0.,0.));#2=IFCAXIS2PLACEMENT3D(#1,$,$);\n\
#3=IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,#1,1.,$);\n\
#10=IFCMAPPEDITEM(#999,#3);#11=IFCREPRESENTATIONMAP(#2,#998);#12=IFCMAPPEDITEM(#11,#3);\n\
#30=IFCSHAPEREPRESENTATION($,'Body','MappedRepresentation',(#10));\n\
#31=IFCSHAPEREPRESENTATION($,'Body','MappedRepresentation',(#12));\n\
#40=IFCPRODUCTDEFINITIONSHAPE($,$,(#30));#41=IFCPRODUCTDEFINITIONSHAPE($,$,(#31));\n\
#20=IFCWALL('0000000000000000000020',$,$,$,$,$,#40,$,$);#21=IFCWALL('0000000000000000000021',$,$,$,$,$,#41,$,$);\n";

#[test]
fn proc_2_every_dropped_mapped_item_is_reported() {
    let content = ifc("IFC4", BAD_MAPS);
    let (profiles, skipped) = extract_profiles_with_diagnostics(&content, 0);
    assert!(profiles.is_empty(), "{profiles:?}");
    let mut skipped_ids: Vec<u32> = skipped.iter().map(|s| s.express_id).collect();
    skipped_ids.sort_unstable();
    assert_eq!(skipped_ids, [20, 21], "{skipped:?}");
}

/// Wall #20's placement axis is an `IfcCartesianPoint`, not an `IfcDirection`,
/// so the mesh path's placement resolver errors. The wall has TWO Body
/// representations; the placement failure is the element's, so it is reported
/// once, not once per representation that retries it (#7690 review).
const BAD_PLACEMENT: &str = "#1=IFCCARTESIANPOINT((0.,0.,0.));#2=IFCCARTESIANPOINT((0.,0.,1.));\n\
#3=IFCAXIS2PLACEMENT3D(#1,#2,$);#4=IFCLOCALPLACEMENT($,#3);\n\
#5=IFCCARTESIANPOINT((0.,0.));#6=IFCAXIS2PLACEMENT2D(#5,$);\n\
#7=IFCRECTANGLEPROFILEDEF(.AREA.,$,#6,1.,1.);#8=IFCDIRECTION((0.,0.,1.));\n\
#10=IFCEXTRUDEDAREASOLID(#7,$,#8,2.);#11=IFCEXTRUDEDAREASOLID(#7,$,#8,3.);\n\
#30=IFCSHAPEREPRESENTATION($,'Body','SweptSolid',(#10));#31=IFCSHAPEREPRESENTATION($,'Body','SweptSolid',(#11));\n\
#40=IFCPRODUCTDEFINITIONSHAPE($,$,(#30,#31));\n\
#20=IFCWALL('0000000000000000000020',$,$,$,$,#4,#40,$,$);\n";

#[test]
fn proc_2_a_placement_failure_is_reported_once_per_element() {
    let content = ifc("IFC4", BAD_PLACEMENT);
    let mut decoder = EntityDecoder::new(&content);
    let router = GeometryRouter::with_units(&content, &mut decoder);
    let wall = decoder.decode_by_id(20).unwrap();
    assert!(
        router.resolve_scaled_placement(&wall, &mut decoder).is_err(),
        "the fixture must make the mesh path's placement resolver fail"
    );
    let (profiles, skipped) = extract_profiles_with_diagnostics(&content, 0);
    assert!(profiles.is_empty(), "{profiles:?}");
    assert_eq!(skipped.len(), 1, "one skip for one element: {skipped:?}");
    assert!(skipped[0].reason.starts_with("placement"), "{skipped:?}");
}

// SPDX-License-Identifier: MPL-2.0
//! Georeferenced fixtures and the world-frame reference for the exporter
//! frame-parity tests (#7734).
//!
//! Every geometry exporter has to put a model where `MeshFrame::to_world` says
//! it is, in the frame it documents. These are the two models that make the
//! frame matter, and the one reference each format's test measures against.

use ifc_lite_processing::process_geometry;

pub(crate) const ROTATED_SITE: &str = "\
ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('','',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0project00000000000001',$,'P',$,$,$,$,(#20),#30);
#30=IFCUNITASSIGNMENT((#31));
#31=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#20=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-5,#21,$);
#21=IFCAXIS2PLACEMENT3D(#22,$,$);
#22=IFCCARTESIANPOINT((0.,0.,0.));
#40=IFCSITE('0site000000000000000001',$,'S',$,$,#41,$,$,.ELEMENT.,$,$,$,$,$);
#41=IFCLOCALPLACEMENT($,#42);
#42=IFCAXIS2PLACEMENT3D(#43,#44,#45);
#43=IFCCARTESIANPOINT((1000.,2000.,0.));
#44=IFCDIRECTION((0.,0.,1.));
#45=IFCDIRECTION((0.,1.,0.));
#50=IFCWALL('0wall000000000000000001',$,'W',$,$,#51,#60,$);
#51=IFCLOCALPLACEMENT(#41,#52);
#52=IFCAXIS2PLACEMENT3D(#53,$,$);
#53=IFCCARTESIANPOINT((0.,0.,0.));
#60=IFCPRODUCTDEFINITIONSHAPE($,$,(#61));
#61=IFCSHAPEREPRESENTATION(#20,'Body','SweptSolid',(#62));
#62=IFCEXTRUDEDAREASOLID(#63,#66,#69,3.);
#63=IFCRECTANGLEPROFILEDEF(.AREA.,$,#64,4.,0.2);
#64=IFCAXIS2PLACEMENT2D(#65,$);
#65=IFCCARTESIANPOINT((2.,0.1));
#66=IFCAXIS2PLACEMENT3D(#67,$,$);
#67=IFCCARTESIANPOINT((0.,0.,0.));
#69=IFCDIRECTION((0.,0.,1.));
#70=IFCRELAGGREGATES('0agg0000000000000000001',$,$,$,#1,(#40));
#71=IFCRELCONTAINEDINSPATIALSTRUCTURE('0con0000000000000000001',$,$,$,(#50),#40);
ENDSEC;
END-ISO-10303-21;
";

/// `IfcSite` at the origin and a wall 5,000 km out: the model-RTC tier, where
/// the baked vertices are small and the whole position is in the frame.
pub(crate) const RTC_MODEL: &str = "\
ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('','',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0project00000000000001',$,'P',$,$,$,$,(#20),#30);
#30=IFCUNITASSIGNMENT((#31));
#31=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#20=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-5,#21,$);
#21=IFCAXIS2PLACEMENT3D(#22,$,$);
#22=IFCCARTESIANPOINT((0.,0.,0.));
#40=IFCSITE('0site000000000000000001',$,'S',$,$,#41,$,$,.ELEMENT.,$,$,$,$,$);
#41=IFCLOCALPLACEMENT($,#42);
#42=IFCAXIS2PLACEMENT3D(#43,$,$);
#43=IFCCARTESIANPOINT((0.,0.,0.));
#50=IFCWALL('0wall000000000000000001',$,'W',$,$,#51,#60,$);
#51=IFCLOCALPLACEMENT(#41,#52);
#52=IFCAXIS2PLACEMENT3D(#53,$,$);
#53=IFCCARTESIANPOINT((5000000.5,3000000.25,12.));
#60=IFCPRODUCTDEFINITIONSHAPE($,$,(#61));
#61=IFCSHAPEREPRESENTATION(#20,'Body','SweptSolid',(#62));
#62=IFCEXTRUDEDAREASOLID(#63,#66,#69,3.);
#63=IFCRECTANGLEPROFILEDEF(.AREA.,$,#64,4.,0.2);
#64=IFCAXIS2PLACEMENT2D(#65,$);
#65=IFCCARTESIANPOINT((2.,0.1));
#66=IFCAXIS2PLACEMENT3D(#67,$,$);
#67=IFCCARTESIANPOINT((0.,0.,0.));
#69=IFCDIRECTION((0.,0.,1.));
#70=IFCRELAGGREGATES('0agg0000000000000000001',$,$,$,#1,(#40));
#71=IFCRELCONTAINEDINSPATIALSTRUCTURE('0con0000000000000000001',$,$,$,(#50),#40);
ENDSEC;
END-ISO-10303-21;
";

/// Both fixtures with the tier each is meant to exercise.
pub(crate) fn frame_fixtures() -> [(&'static str, &'static str, &'static str); 2] {
    [("rotated site", ROTATED_SITE, "site_local"), ("model rtc", RTC_MODEL, "model_rtc")]
}

/// Where the model IS: the IFC Z-up world AABB, from the pipeline's own
/// meshes restored through `MeshFrame::to_world` in f64. Also checks the
/// fixture lands in the tier it is named for, so a test cannot pass over
/// a model that needs no restore.
pub(crate) fn reference_world_aabb(content: &str, tier: &str) -> ([f64; 3], [f64; 3]) {
    let result = process_geometry(content.as_bytes());
    assert_eq!(
        serde_json::to_value(result.frame.coordinate_space()).unwrap(),
        tier,
        "the fixture must exercise the {tier} tier"
    );
    let (mut lo, mut hi) = ([f64::INFINITY; 3], [f64::NEG_INFINITY; 3]);
    for mesh in &result.meshes {
        for p in mesh.positions.chunks_exact(3) {
            let w = result.frame.to_world([
                mesh.origin[0] + p[0] as f64,
                mesh.origin[1] + p[1] as f64,
                mesh.origin[2] + p[2] as f64,
            ]);
            for k in 0..3 {
                lo[k] = lo[k].min(w[k]);
                hi[k] = hi[k].max(w[k]);
            }
        }
    }
    assert!(lo[0].is_finite(), "the fixture meshes");
    (lo, hi)
}

/// Same box to within `tol` metres, per axis.
pub(crate) fn assert_aabb_close(what: &str, got: ([f64; 3], [f64; 3]), want: ([f64; 3], [f64; 3]), tol: f64) {
    for k in 0..3 {
        assert!(
            (got.0[k] - want.0[k]).abs() <= tol && (got.1[k] - want.1[k]).abs() <= tol,
            "{what}: world AABB {got:?} is not where the model is {want:?}"
        );
    }
}

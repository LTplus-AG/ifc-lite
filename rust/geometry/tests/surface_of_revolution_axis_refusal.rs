// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! F3b drift 3.3 (PROC-S7, PROC-S9): `IfcSurfaceOfRevolution.AxisPosition`
//! is read whole by `Axis1Placement::read`. Base swallowed every part with
//! `.ok()`, so an unreadable Location revolved about the origin and an
//! unreadable Axis about +Z; both now refuse the face and count the record.
//! A `$` Axis keeps the IFC derived default +Z (§3.12), as on base.

use ifc_lite_core::{build_entity_index, EntityDecoder};
use ifc_lite_geometry::{GeometryRouter, Mesh};

fn wrap(data: &str) -> String {
    format!(
        "ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION((''),'2;1');\nFILE_NAME('','',(''),(''),'','','');\n\
         FILE_SCHEMA(('IFC4X3_ADD2'));\nENDSEC;\nDATA;\n{data}ENDSEC;\nEND-ISO-10303-21;\n"
    )
}

/// A quarter of the unit cylinder about Z as one advanced face, revolving
/// the segment (1,0,0)-(1,0,1) about the AxisPosition `#11=axis`.
fn revolved_quarter(axis: &str) -> String {
    format!(
        "#1=IFCADVANCEDBREP(#2);\n#2=IFCCLOSEDSHELL((#3));\n#3=IFCADVANCEDFACE((#4),#10,.T.);\n\
         #4=IFCFACEOUTERBOUND(#5,.T.);\n#5=IFCEDGELOOP((#61,#62,#63,#64));\n\
         #10=IFCSURFACEOFREVOLUTION(#13,$,#11);\n#11={axis};\n\
         #12=IFCCARTESIANPOINT((0.,0.,0.));\n#14=IFCDIRECTION((0.,0.,1.));\n\
         #18=IFCCARTESIANPOINT((0.,'x',0.));\n#20=IFCDIRECTION((0.,0.,1.E308));\n#19=IFCDIRECTION((0.,'x',1.));\n\
         #13=IFCARBITRARYOPENPROFILEDEF(.CURVE.,$,#15);\n#15=IFCPOLYLINE((#16,#17));\n\
         #16=IFCCARTESIANPOINT((1.,0.,0.));\n#17=IFCCARTESIANPOINT((1.,0.,1.));\n\
         #21=IFCCARTESIANPOINT((1.,0.,0.));\n#22=IFCCARTESIANPOINT((0.,1.,0.));\n\
         #23=IFCCARTESIANPOINT((0.,1.,1.));\n#24=IFCCARTESIANPOINT((1.,0.,1.));\n\
         #31=IFCVERTEXPOINT(#21);\n#32=IFCVERTEXPOINT(#22);\n#33=IFCVERTEXPOINT(#23);\n#34=IFCVERTEXPOINT(#24);\n\
         #41=IFCPOLYLINE((#21,#22));\n#42=IFCPOLYLINE((#22,#23));\n#43=IFCPOLYLINE((#23,#24));\n#44=IFCPOLYLINE((#24,#21));\n\
         #51=IFCEDGECURVE(#31,#32,#41,.T.);\n#52=IFCEDGECURVE(#32,#33,#42,.T.);\n\
         #53=IFCEDGECURVE(#33,#34,#43,.T.);\n#54=IFCEDGECURVE(#34,#31,#44,.T.);\n\
         #61=IFCORIENTEDEDGE(*,*,#51,.T.);\n#62=IFCORIENTEDEDGE(*,*,#52,.T.);\n\
         #63=IFCORIENTEDEDGE(*,*,#53,.T.);\n#64=IFCORIENTEDEDGE(*,*,#54,.T.);\n"
    )
}

/// The brep's positions (empty for an `Err`) and the decoder's refusal count.
fn process(axis: &str) -> (Vec<f32>, u64) {
    let content = wrap(&revolved_quarter(axis));
    let index = build_entity_index(&content);
    let mut decoder = EntityDecoder::with_index(&content, index);
    let router = GeometryRouter::new();
    let entity = decoder.decode_by_id(1).expect("decode");
    let positions = router
        .process_representation_item(&entity, &mut decoder)
        .map_or_else(|_| Vec::new(), |mesh: Mesh| mesh.positions);
    (positions, decoder.refused_records())
}

#[test]
fn an_unreadable_revolution_axis_position_refuses_the_face_and_counts() {
    let (control, refused) = process("IFCAXIS1PLACEMENT(#12,#14)");
    assert!(control.len() > 4 * 3, "the control quarter cylinder must revolve");
    assert_eq!(refused, 0);
    // A `$` Axis is the IFC default +Z: the same surface as the control.
    let (default_axis, refused) = process("IFCAXIS1PLACEMENT(#12,$)");
    assert_eq!(default_axis, control, "a `$` Axis must revolve about +Z");
    assert_eq!(refused, 0);
    // A +Z whose squared length overflows used to normalise to a zero axis.
    let (huge_axis, refused) = process("IFCAXIS1PLACEMENT(#12,#20)");
    assert_eq!(huge_axis, control, "a 1e308 +Z must revolve about +Z");
    assert_eq!(refused, 0);
    // Base: origin, origin, +Z. Each now refuses the only face.
    for axis in [
        "IFCAXIS1PLACEMENT(#18,#14)",
        "IFCAXIS1PLACEMENT($,#14)",
        "IFCAXIS1PLACEMENT(#12,#19)",
    ] {
        let (positions, refused) = process(axis);
        assert!(positions.is_empty(), "{axis}: an unreadable AxisPosition must refuse the face");
        assert_eq!(refused, 1, "{axis}");
    }
}

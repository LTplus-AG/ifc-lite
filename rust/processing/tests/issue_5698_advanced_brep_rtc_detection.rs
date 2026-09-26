// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! #5698: an identity-placed `IfcAdvancedBrep` at national-grid magnitude
//! must drive RTC detection like a faceted Brep does. Without a vote the
//! model is never rebased, the rebase hook never runs, and the 12 x 7 mm
//! patch below collapses onto one f32 value per axis (ULP 0.25 m at LV95).

use ifc_lite_processing::process_geometry;

const X: f64 = 2_600_000.4;
const Y: f64 = 1_200_000.3;
const DX: f64 = 0.012;
const DY: f64 = 0.007;

fn model() -> String {
    format!(
        "ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION((''),'2;1');\n\
         FILE_NAME('','2026-01-01T00:00:00',(''),(''),'t','t','');\n\
         FILE_SCHEMA(('IFC4X3_ADD2'));\nENDSEC;\nDATA;\n\
         #1=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);\n#2=IFCUNITASSIGNMENT((#1));\n\
         #3=IFCCARTESIANPOINT((0.,0.,0.));\n#4=IFCAXIS2PLACEMENT3D(#3,$,$);\n\
         #5=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,#4,$);\n\
         #6=IFCGEOMETRICREPRESENTATIONSUBCONTEXT('Body','Model',*,*,*,*,#5,$,.MODEL_VIEW.,$);\n\
         #7=IFCPROJECT('01tEAnIV5BixApwp1YzpwS',$,'t',$,$,$,$,(#5),#2);\n\
         #10=IFCCARTESIANPOINT(({X:.6},{Y:.6},0.));\n\
         #11=IFCCARTESIANPOINT(({x1:.6},{Y:.6},0.));\n\
         #12=IFCCARTESIANPOINT(({x1:.6},{y1:.6},0.));\n\
         #13=IFCCARTESIANPOINT(({X:.6},{y1:.6},0.));\n\
         #20=IFCPOLYLOOP((#10,#11,#12,#13));\n#21=IFCFACEOUTERBOUND(#20,.T.);\n\
         #22=IFCBSPLINESURFACEWITHKNOTS(1,1,((#10,#13),(#11,#12)),.UNSPECIFIED.,\
         .F.,.F.,.F.,(2,2),(2,2),(0.,1.),(0.,1.),.UNSPECIFIED.);\n\
         #23=IFCADVANCEDFACE((#21),#22,.T.);\n#24=IFCCLOSEDSHELL((#23));\n\
         #25=IFCADVANCEDBREP(#24);\n\
         #26=IFCSHAPEREPRESENTATION(#6,'Body','AdvancedBrep',(#25));\n\
         #27=IFCPRODUCTDEFINITIONSHAPE($,$,(#26));\n\
         #28=IFCLOCALPLACEMENT($,#4);\n\
         #29=IFCBUILDINGELEMENTPROXY('11tEAnIV5BixApwp1YzpwS',$,'patch',$,$,#28,#27,$,$);\n\
         ENDSEC;\nEND-ISO-10303-21;\n",
        x1 = X + DX,
        y1 = Y + DY,
    )
}

#[test]
fn issue_5698_identity_placed_advanced_brep_is_rebased() {
    let result = process_geometry(&model());
    let rtc = result.frame.rtc_offset();
    assert!(
        (rtc.0 - X).abs() < 10.0 && (rtc.1 - Y).abs() < 10.0,
        "the AdvancedBrep's own vertices must drive RTC detection, got {rtc:?}"
    );
    let rtc = [rtc.0, rtc.1, rtc.2];
    let world: Vec<[f64; 3]> = result
        .meshes
        .iter()
        .flat_map(|mesh| {
            mesh.positions
                .chunks_exact(3)
                .map(move |p| [0, 1, 2].map(|axis| p[axis] as f64 + mesh.origin[axis] + rtc[axis]))
        })
        .collect();
    for corner in [[X, Y], [X + DX, Y], [X + DX, Y + DY], [X, Y + DY]] {
        assert!(
            world
                .iter()
                .any(|v| (v[0] - corner[0]).abs() < 1e-4 && (v[1] - corner[1]).abs() < 1e-4),
            "corner {corner:?} of the 12 x 7 mm patch was lost"
        );
    }
}

// SPDX-License-Identifier: MPL-2.0
#![cfg(feature = "retained-runtime")]
//! #7955: dental_clinic #831's real construction. The first entry of opening
//! #3350's operand frame sums four signed-zero products, so its sign depends
//! only on how the sum is seeded. The controller and the runtime must build
//! that frame the same way, so its receipt compares bit for bit and the wall is
//! not refused as a contract breach (`ForeignBooleanOperationOrOrderedInputs`).
use ifc_lite_core::SourceBundle;
use ifc_lite_processing::element::retained_runtime::{ModelOptions, ProductOutcome};
fn worker() -> Option<std::ffi::OsString> {
    let path = std::env::var_os("IFCLITE_SMLIB_WORKER");
    if path.is_none() {
        assert!(std::env::var_os("IFCLITE_REQUIRE_SMLIB").is_none(), "real SMLib SDK required");
        eprintln!("SKIP frame zero native: set IFCLITE_SMLIB_WORKER; not SDK evidence");
    }
    path
}
/// dental_clinic #831's placement chain, body, clipping halfspace, material
/// layers and both openings (#3350, #40196), with the authored values verbatim.
pub const WALL: &str = "ISO-10303-21;HEADER;FILE_SCHEMA(('IFC4'));ENDSEC;DATA;
#1=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);#2=IFCUNITASSIGNMENT((#1));
#3=IFCPROJECT('0000000000000000000000',$,'SYNTHETIC',$,$,$,$,$,#2);
#10=IFCCARTESIANPOINT((0.0,0.0,0.0));#11=IFCAXIS2PLACEMENT3D(#10,$,$);
#12=IFCLOCALPLACEMENT($,#11);#13=IFCLOCALPLACEMENT(#12,#11);
#14=IFCCARTESIANPOINT((0.0,0.0,4.570000000004098));#15=IFCAXIS2PLACEMENT3D(#14,$,$);
#16=IFCLOCALPLACEMENT(#13,#15);
#17=IFCCARTESIANPOINT((-14.25800000000059,35.27443871025938,0.0));
#18=IFCDIRECTION((0.0,0.0,1.0));#19=IFCDIRECTION((0.0,1.0,0.0));
#20=IFCAXIS2PLACEMENT3D(#17,#18,#19);#21=IFCLOCALPLACEMENT(#16,#20);
#22=IFCCARTESIANPOINT((0.9620000000000131,0.0));#23=IFCDIRECTION((-1.0,0.0));
#24=IFCAXIS2PLACEMENT2D(#22,#23);
#25=IFCRECTANGLEPROFILEDEF(.AREA.,$,#24,1.924000000000026,0.1240000000000021);
#26=IFCEXTRUDEDAREASOLID(#25,#11,#18,4.577999999999983);
#27=IFCCARTESIANPOINT((0.4894652798278635,-0.0,4.577999999999983));
#28=IFCDIRECTION((-0.9198990981076526,-0.0,0.3921551342271669));
#29=IFCAXIS2PLACEMENT3D(#27,#28,#19);#30=IFCPLANE(#29);#31=IFCHALFSPACESOLID(#30,.F.);
#32=IFCBOOLEANCLIPPINGRESULT(.DIFFERENCE.,#26,#31);
#33=IFCSHAPEREPRESENTATION($,'Body','Clipping',(#32));#34=IFCPRODUCTDEFINITIONSHAPE($,$,(#33));
#35=IFCWALLSTANDARDCASE('3Egy$LBd99weR14rW4betD',$,'SYNTHETIC #831',$,$,#21,#34,$,$);
#40=IFCMATERIAL('Plasterboard');#41=IFCMATERIAL('Metal - Stud Layer');
#42=IFCMATERIALLAYER(#40,0.016,$);#43=IFCMATERIALLAYER(#41,0.092,$);
#44=IFCMATERIALLAYERSET((#42,#43,#42),'Basic Wall:Interior - Partition (92mm Stud)');
#45=IFCMATERIALLAYERSETUSAGE(#44,.AXIS2.,.NEGATIVE.,0.062);
#46=IFCRELASSOCIATESMATERIAL('0000000000000000000002',$,$,$,(#35),#45);
#50=IFCCARTESIANPOINT((0.3173101865519039,0.06200000000000058,3.770333333331016));
#51=IFCAXIS2PLACEMENT3D(#50,$,$);#52=IFCLOCALPLACEMENT(#21,#51);
#53=IFCCARTESIANPOINT((-0.8104833419519223,-0.1583653150391835));
#54=IFCCARTESIANPOINT((0.5065089265432405,-0.1583653150391838));
#55=IFCCARTESIANPOINT((0.3039744154086731,0.3167306300783824));
#56=IFCPOLYLINE((#53,#54,#55,#53));#57=IFCARBITRARYCLOSEDPROFILEDEF(.AREA.,$,#56);
#58=IFCDIRECTION((0.0,-1.0,0.0));#59=IFCDIRECTION((-0.3921551342271669,-0.0,-0.9198990981076526));
#60=IFCAXIS2PLACEMENT3D(#10,#58,#59);#61=IFCEXTRUDEDAREASOLID(#57,#60,#18,0.124);
#62=IFCSHAPEREPRESENTATION($,'Body','SweptSolid',(#61));#63=IFCPRODUCTDEFINITIONSHAPE($,$,(#62));
#64=IFCOPENINGELEMENT('21a$vNE211CfrnNzE0dYWT',$,'SYNTHETIC #3350',$,'Opening',#52,#63,$,$);
#65=IFCRELVOIDSELEMENT('0000000000000000000003',$,$,$,#35,#64);
#70=IFCCARTESIANPOINT((0.08000000000000754,-0.06200000000000167,-0.0));
#71=IFCAXIS2PLACEMENT3D(#70,$,$);#72=IFCLOCALPLACEMENT(#21,#71);
#73=IFCCARTESIANPOINT((1.067,0.4575000000000001));#74=IFCDIRECTION((0.0,-1.0));
#75=IFCAXIS2PLACEMENT2D(#73,#74);#76=IFCRECTANGLEPROFILEDEF(.AREA.,$,#75,0.9149999999999998,2.134);
#77=IFCAXIS2PLACEMENT3D(#10,#19,#18);#78=IFCEXTRUDEDAREASOLID(#76,#77,#18,0.124);
#79=IFCSHAPEREPRESENTATION($,'Body','SweptSolid',(#78));#80=IFCPRODUCTDEFINITIONSHAPE($,$,(#79));
#81=IFCOPENINGELEMENT('3eM8WbY_59RR5TDWs3wcjZ',$,'SYNTHETIC #40196',$,'Opening',#72,#80,$,$);
#82=IFCRELVOIDSELEMENT('0000000000000000000004',$,$,$,#35,#81);
ENDSEC;END-ISO-10303-21;";

#[test]
fn issue_7955_signed_zero_plane_frame_publishes_real_sdk() {
    let Some(worker) = worker() else { return };
    let mut outcomes = Vec::new();
    ifc_lite_retained_native::run_model_native(SourceBundle::new(WALL.as_bytes().to_vec()), &worker,
        &ModelOptions { ids: Some([35].into_iter().collect()), ..Default::default() }, |o| outcomes.push(o)).unwrap();
    assert_eq!(outcomes.len(), 1, "one atomic publication/refusal");
    let outcome = outcomes.pop().unwrap();
    let ProductOutcome::Published(shape) = &outcome else { panic!("#831 must not be refused: {outcome:?}") };
    assert_eq!(shape.parts.len(), 3, "16/92/16 mm bands");
    println!("#831 published: {} triangles", shape.parts.iter().map(|p| p.indices.len() / 3).sum::<usize>());
    println!("sdk witness executed: frame_zero_831");
}

// SPDX-License-Identifier: MPL-2.0
//! #7955: external callers distinguish a busy lease and can retry after release.
#![cfg(feature = "retained-runtime")]
use ifc_lite_core::SourceBundle;
use ifc_lite_processing::element::inspect_retained_source;

const SOURCE: &str = "ISO-10303-21;HEADER;FILE_SCHEMA(('IFC4'));ENDSEC;DATA;
#1=IFCCARTESIANPOINT((0.,0.,0.));#2=IFCAXIS2PLACEMENT3D(#1,$,$);
#3=IFCDIRECTION((0.,0.,1.));#4=IFCLOCALPLACEMENT($,#2);
#5=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-5,#2,$);
#10=IFCWALL('0000000000000000000001',$,'Wall',$,$,#4,#11,$,$);
#11=IFCPRODUCTDEFINITIONSHAPE($,$,(#12));
#12=IFCSHAPEREPRESENTATION(#5,'Body','SweptSolid',(#13));
#13=IFCEXTRUDEDAREASOLID(#14,#2,#3,3.);#14=IFCRECTANGLEPROFILEDEF(.AREA.,$,$,2.,4.);
ENDSEC;END-ISO-10303-21;";
const OPTIONS: &str = r#"{"schemaVersion":1,"chordToleranceMetres":0.001,"angleToleranceRadians":0.1,
"maxWork":"10000","maxBytes":"16777216","deadlineMs":"10000","typeGeometryMode":"suppress_instanced",
"normalPolicy":"source_analytic_v1","instancePolicy":"uncut_mapped_v1","interfacePolicy":"certified_internal_v1",
"openings":"all","layers":"preserve","skipSmallCuts":false,"mergeLayers":false}"#;

#[test]
fn issue_7955_busy_public_inspection_retries_only_after_lease_release() {
    let source = SourceBundle::new(SOURCE.as_bytes().to_vec());
    let mut decoder = source.decoder();
    let lease = decoder.try_execution_lease().unwrap();
    // Identity is descriptive fixture data; this test does not attest a build.
    let inspect = |decoder: &mut _| inspect_retained_source(source.clone(), 10, None,
        decoder, OPTIONS, "0000000000000000000000000000000000000000");
    let Err(error) = inspect(&mut decoder) else { panic!("busy source must refuse"); };
    assert_eq!(error.diagnostic_code_json(), "\"OWNER_BUSY\"");
    drop(lease);
    let report = inspect(&mut decoder).expect("released source remains usable");
    let value: serde_json::Value = serde_json::from_slice(report.bytes().unwrap()).unwrap();
    assert_eq!(value["outcome"]["kind"], "requires_numerical_evaluation");
    assert_eq!(value["authority"], "diagnostic_only");
    assert!(decoder.try_execution_lease().is_ok());
}

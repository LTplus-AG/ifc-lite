// SPDX-License-Identifier: MPL-2.0
//! #7955: derived coverage is proved from IFC, never inferred from a mesh.
use super::*;
use ifc_lite_core::SourceBundle;
const WALL: &str = include_str!("../../../../tests/evidence/retained-layers-j3/circular-wall-2.ifc");
fn proof(text: &str, offsets: &[f64]) -> std::result::Result<DerivedLayerRegions, String> {
    let bundle = SourceBundle::new(text.as_bytes().to_vec());
    DerivedLayerRegions::capture(15, 53, offsets, 1., &mut bundle.decoder())
}
#[test]
fn j3_derived_sector_coverage_requires_entire_source_body() {
    let region = proof(WALL, &[0.,1.,3.]).expect("J3_COVERAGE");
    assert_eq!(region.len(),2);
    for text in [WALL.replace("#103=IFCCIRCLE(#101,7)","#103=IFCCIRCLE(#101,6)"),
        WALL.replace("#52=IFCCIRCLE(#51,10.)", "#52=IFCCIRCLE(#51,11.)"),
        WALL.replace("#15=IFCEXTRUDEDAREASOLID(#117,#5,#7,3.)", "#15=IFCEXTRUDEDAREASOLID(#117,#251,#7,3.)")] {
        assert!(proof(&text,&[0.,1.,3.]).is_err(),"J3_COVERAGE");
    }
    assert!(proof(WALL,&[0.,1.,2.]).is_err(),"J3_COVERAGE");
    assert!(proof(WALL,&[0.,1.,1.,3.]).is_err());
    assert!(proof(WALL,&[0.,11.,3.]).is_err());
}
#[test]
fn j3_derived_negative_preserves_authored_order() {
    let region = proof(WALL,&[3.,1.,0.]).unwrap();
    assert_eq!(region.radii(0),Some((7.,9.)));
    assert_eq!(region.radii(1),Some((9.,10.)));
}

// SPDX-License-Identifier: MPL-2.0
//! #7955 source coverage checks require no runtime or fabricated geometry.
use super::*;
use ifc_lite_core::SourceBundle;
const WALL: &str = include_str!("../../../../../../tests/evidence/retained-layers-j3/circular-wall-2.ifc");
#[test]
fn j3_derived_source_refuses_mapping_and_uncovered_body() {
    for text in [WALL.replace("#15=IFCEXTRUDEDAREASOLID(#117,#5,#7,3.)", "#15=IFCMAPPEDITEM(#900,#901)"),
        WALL.replace("#31=IFCMATERIALLAYER(#21,2.,", "#31=IFCMATERIALLAYER(#21,1.,")] {
        let source = SourceBundle::new(text.as_bytes().to_vec());
        let mut decoder = source.decoder();
        let router = GeometryRouter::with_units(&text,&mut decoder);
        let context = ProductionModel::from_source(source.clone()).snapshot(Default::default());
        let product = decoder.decode_by_id(10).unwrap();
        let layers = super::super::layers::capture(&context,&product,&mut decoder,&router).unwrap().unwrap();
        assert!(capture_regions(&layers,&product,&mut decoder).is_err(),"J3_COVERAGE");
    }
}

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! F3e X1 (#7780): `IfcLinearPlacement`'s attributes move between releases.
//!
//! | schema | attributes in order |
//! |---|---|
//! | IFC4X1 | PlacementRelTo, Distance, Orientation, CartesianPosition |
//! | IFC4X2 | PlacementRelTo, PlacementMeasuredAlong, Distance, Orientation, CartesianPosition |
//! | IFC4X3 | PlacementRelTo, RelativePlacement, CartesianPosition |
//!
//! The resolver read `CartesianPosition` at the IFC4X3 position (2) and
//! `RelativePlacement` at 1 whatever the file declared. On an IFC4X1 or IFC4X2
//! file those are `Distance`/`Orientation` or `PlacementMeasuredAlong`/
//! `Distance`: the type checks rejected both, so an authored
//! `CartesianPosition` (3 / 4) was never read and the product fell back to an
//! identity frame, piled at the model origin. The positions now come from
//! `slot::IfcLinearPlacement`, resolved against the declared schema.

use ifc_lite_core::EntityDecoder;
use ifc_lite_geometry::GeometryRouter;

/// A model whose product sits under placement `#10`, written in `placement`'s
/// schema-specific attribute layout. `#4` is the authored `CartesianPosition`
/// frame, 10 / 20 / 3 from the origin.
fn model(schema: &str, placement: &str) -> String {
    format!(
        "ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION((''),'2;1');\nFILE_NAME('','',(''),(''),'','','');\n\
FILE_SCHEMA(('{schema}'));\nENDSEC;\nDATA;\n\
#1=IFCCARTESIANPOINT((0.,0.,0.));\n#2=IFCAXIS2PLACEMENT3D(#1,$,$);\n\
#3=IFCCARTESIANPOINT((10.,20.,3.));\n#4=IFCAXIS2PLACEMENT3D(#3,$,$);\n\
#5=IFCCARTESIANPOINT((0.,0.));\n#6=IFCAXIS2PLACEMENT2D(#5,$);\n\
#7=IFCRECTANGLEPROFILEDEF(.AREA.,$,#6,2.,2.);\n#8=IFCDIRECTION((0.,0.,1.));\n\
#9=IFCEXTRUDEDAREASOLID(#7,#2,#8,1.);\n\
#10={placement};\n\
#11=IFCSHAPEREPRESENTATION($,'Body','SweptSolid',(#9));\n\
#12=IFCPRODUCTDEFINITIONSHAPE($,$,(#11));\n\
#13=IFCBUILDINGELEMENTPROXY('0aBcDeFgHiJkLmNoPqRsT0',$,'P',$,$,#10,#12,$,$);\n\
ENDSEC;\nEND-ISO-10303-21;\n"
    )
}

/// The placement's strict local frame translation, or the refusal.
fn local_translation(content: &str) -> Result<[f64; 3], String> {
    let mut decoder = EntityDecoder::new(content);
    let placement = decoder.decode_by_id(10).expect("placement #10");
    GeometryRouter::new()
        .resolve_linear_placement_local_strict(&placement, &mut decoder)
        .map(|m| [m[12], m[13], m[14]])
        .map_err(|e| e.to_string())
}

/// The product's mesh bounds (min x, min y, min z).
fn product_min(content: &str) -> [f32; 3] {
    let mut decoder = EntityDecoder::new(content);
    let product = decoder.decode_by_id(13).expect("product #13");
    let mesh = GeometryRouter::new().process_element(&product, &mut decoder).expect("product meshes");
    let (lo, _) = mesh.bounds();
    [lo.x, lo.y, lo.z]
}

#[test]
fn ifc4x2_cartesian_position_at_4_places_the_frame() {
    // Before: slot 2 is `Distance`, a type-guarded miss, so `Err`.
    assert_eq!(local_translation(&model("IFC4X2", "IFCLINEARPLACEMENT($,$,$,$,#4)")), Ok([10., 20., 3.]));
}

#[test]
fn ifc4x1_cartesian_position_at_3_places_the_frame() {
    assert_eq!(local_translation(&model("IFC4X1", "IFCLINEARPLACEMENT($,$,$,#4)")), Ok([10., 20., 3.]));
}

#[test]
fn ifc4x3_cartesian_position_at_2_is_unchanged() {
    assert_eq!(local_translation(&model("IFC4X3_ADD2", "IFCLINEARPLACEMENT($,$,#4)")), Ok([10., 20., 3.]));
}

#[test]
fn a_mislabelled_ifc4_file_keeps_the_ifc4x3_layout() {
    // IfcLinearPlacement is declared from IFC4X1 on. An IFC2X3/IFC4 label on a file that
    // carries one is an IFC4X3 export with the wrong header, read as such as it always was.
    for schema in ["IFC2X3", "IFC4"] {
        assert_eq!(local_translation(&model(schema, "IFCLINEARPLACEMENT($,$,#4)")), Ok([10., 20., 3.]), "{schema}");
    }
}

#[test]
fn the_position_follows_the_declared_schema_not_the_type_at_it() {
    // In IFC4X2 slot 2 is `Distance`: a frame written there is not a
    // CartesianPosition, and nothing sits at 4. The old reader took it for one.
    let misplaced = local_translation(&model("IFC4X2", "IFCLINEARPLACEMENT($,$,#4,$,$)"));
    assert!(misplaced.is_err(), "{misplaced:?}");
    // And in IFC4X3 slot 3 does not exist: a trailing value is not read.
    let beyond = local_translation(&model("IFC4X3_ADD2", "IFCLINEARPLACEMENT($,$,$,#4)"));
    assert!(beyond.is_err(), "{beyond:?}");
}

#[test]
fn a_product_on_an_ifc4x2_linear_placement_lands_at_its_authored_position() {
    // The 2 m square profile is centred, so its minimum corner is (9, 19, 3).
    let placed = product_min(&model("IFC4X2", "IFCLINEARPLACEMENT($,$,$,$,#4)"));
    assert_eq!(placed, [9., 19., 3.], "placed by CartesianPosition");
    // #7779 D3/D30: the canonical chain refuses an unreadable local frame.
    // Keep the invalid control, but do not certify fabricated origin geometry.
    let content = model("IFC4X2", "IFCLINEARPLACEMENT($,$,$,$,$)");
    let mut decoder = EntityDecoder::new(&content);
    let product = decoder.decode_by_id(13).expect("product #13");
    let error = GeometryRouter::new().process_element(&product, &mut decoder)
        .expect_err("an empty LinearPlacement has no resolvable local frame");
    assert!(error.to_string().contains("CartesianPosition or RelativePlacement"), "{error}");
    assert_eq!(decoder.refused_records(), 1, "the canonical missing frame is counted once");
    assert_eq!(product_min(&model("IFC4X1", "IFCLINEARPLACEMENT($,$,$,#4)")), [9., 19., 3.]);
}

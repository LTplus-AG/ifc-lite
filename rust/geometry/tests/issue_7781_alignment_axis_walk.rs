// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! C2 (#7781): an IFC4X3 `IfcAlignment`'s `Representation` is read through the
//! shared `product_shape` walk, not a private `6 -> 2 -> 3` chain.
//!
//! What the walk keeps: `'Axis'` over `'FootPrint'` whatever the list order,
//! the `'FootPrint'` when there is no `'Axis'`, the identifier in any letter
//! case, an `IfcSegmentedReferenceCurve`'s `BaseCurve`, and skipping items
//! that are not a usable curve.
//!
//! What it changes (Class X): a malformed shape yields no curve where the
//! private walk stepped over the broken part. That is a `Representations`
//! member that does not decode, a bare reference where that list belongs, and,
//! on an `'Axis'` or `'FootPrint'` representation, an `Items` member that does
//! not decode, a bare reference or `$` where `Items` belongs. A broken `'Axis'`
//! no longer hands the alignment its plan-only `'FootPrint'`.

use ifc_lite_core::EntityDecoder;
use ifc_lite_geometry::locate_axis_curve;

/// `#4` and `#5` are polylines, `#6` a gradient curve and `#7` a segmented
/// reference curve over it; `#9` is a solid (not a curve). `shape` and `reps`
/// are spliced in verbatim, so a test lays out the representation chain.
fn model(shape: &str, reps: &str) -> String {
    format!(
        "ISO-10303-21;\nHEADER;\nFILE_SCHEMA(('IFC4X3_ADD2'));\nENDSEC;\nDATA;\n\
#1=IFCCARTESIANPOINT((0.,0.,0.));\n#2=IFCCARTESIANPOINT((10.,0.,0.));\n\
#3=IFCCARTESIANPOINT((20.,0.,0.));\n\
#4=IFCPOLYLINE((#1,#2));\n#5=IFCPOLYLINE((#1,#3));\n\
#6=IFCGRADIENTCURVE((),.F.,#4,$);\n#7=IFCSEGMENTEDREFERENCECURVE((),.F.,#6,$);\n\
#9=IFCBLOCK($,1.,1.,1.);\n\
{reps}\n#30={shape};\n\
#40=IFCALIGNMENT('0aBcDeFgHiJkLmNoPqRsT0',$,'A',$,$,$,#30,.USERDEFINED.);\n\
ENDSEC;\nEND-ISO-10303-21;\n"
    )
}

/// The express id of the located directrix.
fn located(content: &str) -> Option<u32> {
    let mut decoder = EntityDecoder::new(content);
    let alignment = decoder.decode_by_id(40).expect("alignment #40");
    locate_axis_curve(&alignment, &mut decoder).map(|curve| curve.id)
}

const FOOTPRINT_4: &str = "#20=IFCSHAPEREPRESENTATION($,'FootPrint','Curve2D',(#4));";
const AXIS_5: &str = "#21=IFCSHAPEREPRESENTATION($,'Axis','Curve3D',(#5));";

#[test]
fn axis_wins_over_footprint_in_either_order() {
    let reps = format!("{FOOTPRINT_4}\n{AXIS_5}");
    for list in ["(#20,#21)", "(#21,#20)"] {
        let content = model(&format!("IFCPRODUCTDEFINITIONSHAPE($,$,{list})"), &reps);
        assert_eq!(located(&content), Some(5), "{list}");
    }
}

#[test]
fn the_first_usable_footprint_stands_in_for_a_missing_axis() {
    let reps = "#20=IFCSHAPEREPRESENTATION($,'FootPrint','Curve2D',(#9,#4));\n\
#21=IFCSHAPEREPRESENTATION($,'FootPrint','Curve2D',(#5));\n\
#22=IFCSHAPEREPRESENTATION($,'Body','SweptSolid',(#9));";
    let content = model("IFCPRODUCTDEFINITIONSHAPE($,$,(#22,#20,#21))", reps);
    assert_eq!(located(&content), Some(4), "the solid #9 is stepped over");
}

#[test]
fn the_identifier_matches_in_any_letter_case() {
    let reps = "#20=IFCSHAPEREPRESENTATION($,'footprint','Curve2D',(#4));\n\
#21=IFCSHAPEREPRESENTATION($,'aXiS','Curve3D',(#5));";
    let content = model("IFCPRODUCTDEFINITIONSHAPE($,$,(#20,#21))", reps);
    assert_eq!(located(&content), Some(5));
}

#[test]
fn a_segmented_reference_curve_contributes_its_gradient_base_curve() {
    let reps = "#21=IFCSHAPEREPRESENTATION($,'Axis','Curve3D',(#7));";
    let content = model("IFCPRODUCTDEFINITIONSHAPE($,$,(#21))", reps);
    assert_eq!(located(&content), Some(6));
}

#[test]
fn a_non_axis_representation_with_an_unresolved_item_is_not_read() {
    // `#99` does not exist. The `'Body'` representation is never selected, so
    // its broken item cannot affect the directrix.
    let reps = format!("{AXIS_5}\n#22=IFCSHAPEREPRESENTATION($,'Body','SweptSolid',(#99));");
    let content = model("IFCPRODUCTDEFINITIONSHAPE($,$,(#22,#21))", &reps);
    assert_eq!(located(&content), Some(5));
}

#[test]
fn a_usable_curve_in_a_body_representation_is_not_a_directrix() {
    // Only 'Axis' and 'FootPrint' are read: the polyline #4 under 'Body' is
    // neither, whatever the list order.
    let reps = "#22=IFCSHAPEREPRESENTATION($,'Body','Curve3D',(#4));\n\
#20=IFCSHAPEREPRESENTATION($,'FootPrint','Curve2D',(#5));";
    let content = model("IFCPRODUCTDEFINITIONSHAPE($,$,(#22,#20))", reps);
    assert_eq!(located(&content), Some(5));
    let body_only = model("IFCPRODUCTDEFINITIONSHAPE($,$,(#22))", reps);
    assert_eq!(located(&body_only), None);
}

#[test]
fn no_axis_and_no_footprint_is_none() {
    let reps = "#22=IFCSHAPEREPRESENTATION($,'Body','SweptSolid',(#9));";
    let content = model("IFCPRODUCTDEFINITIONSHAPE($,$,(#22))", reps);
    assert_eq!(located(&content), None);
    let no_list = model("IFCPRODUCTDEFINITIONSHAPE($,$,$)", "");
    assert_eq!(located(&no_list), None);
}

#[test]
fn an_unresolved_representation_refuses_the_shape() {
    // Class X. The private walk stepped over the dangling `#99` (and returned
    // the Axis before reaching it); the shared walk refuses the whole shape.
    let content = model("IFCPRODUCTDEFINITIONSHAPE($,$,(#21,#99))", AXIS_5);
    assert_eq!(located(&content), None);
}

#[test]
fn a_bare_reference_in_place_of_the_representations_list_is_refused() {
    // Class X. `Representations` is a LIST; the private walk read a bare `#21`
    // as a one-member list.
    let content = model("IFCPRODUCTDEFINITIONSHAPE($,$,#21)", AXIS_5);
    assert_eq!(located(&content), None);
}

/// Both list orders of `reps` #20 and #21.
fn either_order(reps: &str) -> [Option<u32>; 2] {
    ["(#20,#21)", "(#21,#20)"].map(|list| {
        located(&model(
            &format!("IFCPRODUCTDEFINITIONSHAPE($,$,{list})"),
            reps,
        ))
    })
}

#[test]
fn a_malformed_axis_refuses_the_shape_beside_a_valid_footprint() {
    // Class X. The private walk stepped over the broken item and took `#5`
    // from the same Axis; the r1 shared walk dropped the Axis and returned the
    // plan-only FootPrint `#4`. A broken Axis now refuses the shape: an
    // unresolved member, a bare reference or `$` where `Items` belongs.
    for items in ["(#99,#5)", "#5", "$"] {
        let reps =
            format!("{FOOTPRINT_4}\n#21=IFCSHAPEREPRESENTATION($,'Axis','Curve3D',{items});");
        assert_eq!(either_order(&reps), [None, None], "Axis Items {items}");
    }
}

#[test]
fn a_malformed_footprint_refuses_the_shape_beside_a_valid_axis() {
    // Class X: the same rule for the other selected representation, so the
    // answer does not depend on which of the two is broken or listed first.
    for items in ["(#99,#4)", "#4", "$"] {
        let reps =
            format!("#20=IFCSHAPEREPRESENTATION($,'FootPrint','Curve2D',{items});\n{AXIS_5}");
        assert_eq!(either_order(&reps), [None, None], "FootPrint Items {items}");
    }
}

#[test]
fn a_well_formed_shape_is_read_in_either_order() {
    // The control for the two tests above: the same shapes, nothing broken.
    let reps = format!("{FOOTPRINT_4}\n{AXIS_5}");
    assert_eq!(either_order(&reps), [Some(5), Some(5)]);
    let footprints = "#20=IFCSHAPEREPRESENTATION($,'FootPrint','Curve2D',(#9,#4));\n\
#21=IFCSHAPEREPRESENTATION($,'FootPrint','Curve2D',(#5));";
    assert_eq!(
        either_order(footprints),
        [Some(4), Some(5)],
        "the first usable FootPrint"
    );
}

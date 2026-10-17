// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! F3b X2: the chain refuses what it cannot read (D30, drift 3.5/3.8/3.10)
//! instead of drawing the element at a fallback position. Every case below
//! resolved to the identity (or a displaced garbage frame) on the base commit.

use super::*;
use ifc_lite_core::EntityDecoder;

fn doc(body: &str) -> String {
    format!(
        "ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION((''),'2;1');\n\
FILE_NAME('t.ifc','2024-01-01T00:00:00',(''),(''),'','','');\n\
FILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\n{body}ENDSEC;\nEND-ISO-10303-21;\n"
    )
}

/// `#1` a 3D frame at (1,0,0), `#2` a 2D frame at (0,5) rotated 90 degrees.
const FRAMES: &str = "#1=IFCAXIS2PLACEMENT3D(#3,$,$);\n#3=IFCCARTESIANPOINT((1.,0.,0.));\n\
#4=IFCCARTESIANPOINT((0.,5.));\n#5=IFCDIRECTION((0.,1.));\n#2=IFCAXIS2PLACEMENT2D(#4,#5);\n";

fn resolve(body: &str, id: u32) -> (PlacementResult<Matrix4<f64>>, u64) {
    let content = doc(&format!("{FRAMES}{body}"));
    let mut decoder = EntityDecoder::new(&content);
    let placement = decoder.decode_by_id(id).expect("placement");
    let result = resolve_chain(&placement, &mut decoder);
    (result, decoder.refused_records())
}

/// §3.5: a 2D RelativePlacement is legal in `IfcLocalPlacement` and is honoured
/// (base: silently the identity, the product sat at the origin).
#[test]
fn a_2d_relative_placement_translates_and_rotates_the_product() {
    let (result, refused) = resolve("#10=IFCLOCALPLACEMENT($,#2);\n#11=IFCLOCALPLACEMENT(#10,#1);\n", 11);
    let m = result.expect("2D relative placement");
    assert_eq!((m[(0, 3)], m[(1, 3)], m[(2, 3)]), (0.0, 6.0, 0.0), "root (0,5), then (1,0,0) rotated onto +Y");
    assert_eq!((m[(0, 0)], m[(1, 0)]), (0.0, 1.0), "local X is the 2D RefDirection (0,1)");
    assert_eq!(refused, 0);
}

#[test]
fn a_dollar_relative_placement_is_refused_and_counted() {
    let (result, refused) = resolve("#10=IFCLOCALPLACEMENT($,$);\n#11=IFCLOCALPLACEMENT(#10,#1);\n", 11);
    assert!(matches!(result, Err(PlacementError::Missing { at: 10, attr: "RelativePlacement" })), "{result:?}");
    assert_eq!(refused, 1);
}

#[test]
fn a_relative_placement_that_is_not_an_axis_placement_is_refused_and_counted() {
    let (result, refused) = resolve("#10=IFCLOCALPLACEMENT($,#3);\n", 10);
    assert!(matches!(result, Err(PlacementError::Unsupported { at: 3, .. })), "{result:?}");
    assert_eq!(refused, 1);
}

#[test]
fn a_placement_rel_to_that_is_not_a_placement_is_refused_and_counted() {
    // Base ended the walk at #1 and returned the leaf's local frame alone.
    let (result, refused) = resolve("#10=IFCLOCALPLACEMENT(#1,#1);\n", 10);
    assert!(matches!(result, Err(PlacementError::Unsupported { at: 1, .. })), "{result:?}");
    assert_eq!(refused, 1);
    let content = doc(&format!("{FRAMES}#10=IFCLOCALPLACEMENT(#1,#1);\n"));
    let mut decoder = EntityDecoder::new(&content);
    let leaf = decoder.decode_by_id(10).unwrap();
    assert!(matches!(chain(&leaf, &mut decoder), Err(PlacementError::Unsupported { at: 1, .. })));
}

/// §3.10: base composed the identity for a linear/grid frame it could not
/// sample, so the element sat at its parent's origin.
#[test]
fn an_unsampleable_linear_or_grid_frame_is_refused_and_counted() {
    for (body, id) in [
        ("#10=IFCLINEARPLACEMENT($,$,$);\n", 10),
        ("#10=IFCLOCALPLACEMENT($,#1);\n#11=IFCLINEARPLACEMENT(#10,$,$);\n", 11),
        ("#10=IFCGRIDPLACEMENT($,$,$);\n", 10),
    ] {
        let (result, refused) = resolve(body, id);
        assert!(matches!(result, Err(PlacementError::Missing { .. })), "{body}: {result:?}");
        assert_eq!(refused, 1, "{body}");
    }
}

/// A refusal is never memoised, and the placements below it that did resolve
/// keep their own (complete) answers, so cold and warm decoders agree.
#[test]
fn a_refusal_poisons_neither_its_ancestors_nor_a_second_asker() {
    let body = "#10=IFCLOCALPLACEMENT($,#1);\n#11=IFCLOCALPLACEMENT(#10,$);\n#12=IFCLOCALPLACEMENT(#11,#1);\n";
    let content = doc(&format!("{FRAMES}{body}"));
    let mut decoder = EntityDecoder::new(&content);
    for id in [12, 12, 11] {
        let node = decoder.decode_by_id(id).unwrap();
        assert!(resolve_chain(&node, &mut decoder).is_err(), "#{id}");
    }
    assert!(decoder.get_placement_transform_cached(11).is_none());
    assert!(decoder.get_placement_transform_cached(12).is_none());
    let root = decoder.decode_by_id(10).unwrap();
    assert_eq!(resolve_chain(&root, &mut decoder).unwrap()[(0, 3)], 1.0);
    assert_eq!(decoder.refused_records(), 1, "one bad record, counted once");
}

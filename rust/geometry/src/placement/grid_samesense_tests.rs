// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! `IfcGridAxis.SameSense` in `IfcGridPlacement` offsets (#8159 follow-up).
//!
//! IFC4 `IfcGridAxis.SameSense`: "If TRUE, the grid axis has the same sense as
//! the parameterization of the AxisCurve; if FALSE, the axis runs against it",
//! i.e. from the curve's end to its start. IFC4 `IfcVirtualGridIntersection.
//! OffsetDistances`: "the distances from the intersection of the grid axes
//! along the normal of each axis" - measured relative to the axis direction,
//! so a `.F.` axis offsets to the opposite side of its curve's left normal.
//!
//! Fixture: P is the curve (0,0)->(10,0), Q is the curve (0,0)->(0,10).
//! Offsets (2,3,4): a offset of +d from an axis lies on the axis' left (+90deg
//! of its direction). Hand-computed, with P/Q = .T./.T.:
//!   P dir +X, left +Y -> y = +2;  Q dir +Y, left -X -> x = -3  => (-3, 2, 4)
//! P .F.: P dir -X, left -Y -> y = -2                           => (-3,-2, 4)
//! Q .F.: Q dir -Y, left +X -> x = +3                           => ( 3, 2, 4)
//! both .F.                                                     => ( 3,-2, 4)

use super::*;
use crate::Point3;
use ifc_lite_core::{build_entity_index, EntityDecoder};

fn origin_for(p_sense: &str, q_sense: &str) -> Point3<f64> {
    let content = format!(
        "ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION((''),'2;1');\nFILE_NAME('','',(''),(''),'','','');\n\
FILE_SCHEMA(('IFC4X3_ADD2'));\nENDSEC;\nDATA;\n\
#1=IFCCARTESIANPOINT((0.,0.));\n#2=IFCCARTESIANPOINT((10.,0.));\n#3=IFCPOLYLINE((#1,#2));\n\
#4=IFCGRIDAXIS('P',#3,{p_sense});\n#5=IFCCARTESIANPOINT((0.,10.));\n#6=IFCPOLYLINE((#1,#5));\n\
#7=IFCGRIDAXIS('Q',#6,{q_sense});\n#30=IFCVIRTUALGRIDINTERSECTION((#4,#7),(2.,3.,4.));\n\
#31=IFCGRIDPLACEMENT($,#30,$);\nENDSEC;\nEND-ISO-10303-21;\n"
    );
    let ei = build_entity_index(&content);
    let mut decoder = EntityDecoder::with_index(&content, ei);
    let placement = decoder.decode_by_id(31).expect("decode #31");
    let m = resolve_chain(&placement, &mut decoder).expect("resolve #31");
    Point3::new(m[(0, 3)], m[(1, 3)], m[(2, 3)])
}

fn assert_origin(p: &str, q: &str, want: [f64; 3]) {
    let o = origin_for(p, q);
    assert!((o - Point3::new(want[0], want[1], want[2])).norm() < 1e-9, "P={p} Q={q} origin={o:?}");
}

#[test]
fn same_sense_true_is_unchanged() {
    assert_origin(".T.", ".T.", [-3.0, 2.0, 4.0]);
}

#[test]
fn same_sense_false_on_p_offsets_to_the_other_side() {
    assert_origin(".F.", ".T.", [-3.0, -2.0, 4.0]);
}

#[test]
fn same_sense_false_on_q_offsets_to_the_other_side() {
    assert_origin(".T.", ".F.", [3.0, 2.0, 4.0]);
}

#[test]
fn same_sense_false_on_both_axes() {
    assert_origin(".F.", ".F.", [3.0, -2.0, 4.0]);
}

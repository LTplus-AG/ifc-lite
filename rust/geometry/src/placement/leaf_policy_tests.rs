// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! F3b X1 (#7779): one leaf rule on every placement reader (D3, D25, D26).
//!
//! A point or direction is an `IfcCartesianPoint` / `IfcDirection` holding 2 or
//! 3 finite numbers (2 promotes to z = 0). Anything else is refused and counted
//! in `EntityDecoder::refused_records`, on every reader alike. Base read
//! `((1.))` as (1, 0, 0), `((1.,'x'))` as (1, 0, 0) and `((1.,2.,3.,4.))` as
//! (1, 2, 3) (`unwrap_or(0.0)`), and accepted an `IfcDirection` in a Location
//! slot on the fast path.

use super::*;
use crate::GeometryRouter;
use ifc_lite_core::Error as CoreError;

const BAD_LEAVES: [&str; 5] = [
    "((1.))",
    "((1.,'x'))",
    "((1.,2.,3.,4.))",
    "((IFCLENGTHMEASURE(1.),2.))",
    "(())",
];

/// Every reader of an `IfcAxis2Placement3D` (#2) whose Location is #1.
fn placement_3d_readers(content: &str) -> Vec<(&'static str, Result<(), crate::Error>, u64)> {
    type Reader = fn(&mut EntityDecoder) -> Result<(), crate::Error>;
    let readers: [(&str, Reader); 6] = [
        ("EntityDecoder::point3", |d| d.point3(1).map(drop).map_err(Into::into)),
        ("EntityDecoder::point3_at", |d| {
            let placement = d.decode_by_id(2)?;
            d.point3_at(&placement, 0).map(drop).map_err(Into::into)
        }),
        ("Axis2Placement::read_3d", |d| {
            let placement = d.decode_by_id(2)?;
            Axis2Placement::read_3d(&placement, d).map(drop).map_err(Into::into)
        }),
        ("router.parse_axis2_placement_3d", |d| {
            let placement = d.decode_by_id(2)?;
            GeometryRouter::new().parse_axis2_placement_3d(&placement, d).map(drop)
        }),
        ("Axis2Placement::read_id", |d| Axis2Placement::read_id(2, d).map(drop).map_err(Into::into)),
        ("resolve_chain", |d| {
            let placement = d.decode_by_id(4)?;
            resolve_chain(&placement, d).map(drop).map_err(Into::into)
        }),
    ];
    readers
        .into_iter()
        .map(|(name, read)| {
            let mut decoder = EntityDecoder::new(content);
            let result = read(&mut decoder);
            (name, result, decoder.refused_records())
        })
        .collect()
}

fn doc(location: &str, axis: &str, ref_direction: &str) -> String {
    format!(
        "#1=IFCCARTESIANPOINT{location};\n#10=IFCDIRECTION{axis};\n#11=IFCDIRECTION{ref_direction};\n\
         #2=IFCAXIS2PLACEMENT3D(#1,#10,#11);\n#3=IFCAXIS2PLACEMENT2D(#1,#11);\n#4=IFCLOCALPLACEMENT($,#2);\n"
    )
}

#[test]
fn a_malformed_location_is_refused_and_counted_by_every_reader() {
    for bad in BAD_LEAVES {
        for (reader, result, refused) in placement_3d_readers(&doc(bad, "((0.,0.,1.))", "((1.,0.,0.))")) {
            match result {
                Err(crate::Error::CoreError(CoreError::MalformedRecord(1))) => {}
                other => panic!("{reader} on {bad}: expected the counted refusal of #1, got {other:?}"),
            }
            assert_eq!(refused, 1, "{reader} on {bad}: counter delta");
        }
    }
}

#[test]
fn a_malformed_axis_or_ref_direction_is_refused_and_counted() {
    for bad in ["((0.,'x'))", "((1.))", "((0.,0.,1.,5.))", "((IFCREAL(1.),0.,0.))"] {
        for (axis, ref_direction, record) in [(bad, "((1.,0.,0.))", 10), ("((0.,0.,1.))", bad, 11)] {
            for (reader, result, refused) in placement_3d_readers(&doc("((1.,2.,3.))", axis, ref_direction)) {
                if reader.starts_with("EntityDecoder::point3") {
                    assert!(result.is_ok(), "{reader} reads only the point");
                    continue;
                }
                match result {
                    Err(crate::Error::CoreError(CoreError::MalformedRecord(id))) if id == record => {}
                    other => panic!("{reader} on {bad} (#{record}): got {other:?}"),
                }
                assert_eq!(refused, 1, "{reader} on {bad} (#{record})");
            }
        }
    }
}

#[test]
fn the_record_type_is_checked_in_every_slot() {
    // An IfcDirection in the Location slot, an IfcCartesianPoint in Axis/RefDirection.
    let swapped = "#1=IFCDIRECTION((1.,2.,3.));\n#10=IFCDIRECTION((0.,0.,1.));\n#11=IFCDIRECTION((1.,0.,0.));\n\
                   #2=IFCAXIS2PLACEMENT3D(#1,#10,#11);\n#3=IFCAXIS2PLACEMENT2D(#1,#11);\n#4=IFCLOCALPLACEMENT($,#2);\n";
    for (reader, result, refused) in placement_3d_readers(swapped) {
        assert!(result.is_err(), "{reader}: an IfcDirection is not a Location");
        assert_eq!(refused, 1, "{reader}");
    }
    let point_as_axis = "#1=IFCCARTESIANPOINT((1.,2.,3.));\n#10=IFCCARTESIANPOINT((0.,0.,1.));\n#11=IFCDIRECTION((1.,0.,0.));\n\
                         #2=IFCAXIS2PLACEMENT3D(#1,#10,#11);\n";
    let mut decoder = EntityDecoder::new(point_as_axis);
    assert!(Axis2Placement::read_id(2, &mut decoder).is_err());
    assert_eq!(decoder.refused_records(), 1);
    let mut decoder = EntityDecoder::new(point_as_axis);
    assert!(decoder.direction3(1).is_err(), "a point is not a direction");
    assert_eq!(decoder.refused_records(), 1);
}

#[test]
fn a_clean_read_counts_nothing_and_two_components_promote_to_z_zero() {
    let content = "#1=IFCCARTESIANPOINT((1,2));\n#10=IFCDIRECTION((0,1));\n#11=IFCDIRECTION((1.,0.,0.));\n\
                   #2=IFCAXIS2PLACEMENT3D(#1,$,#11);\n#3=IFCAXIS2PLACEMENT3D(#1,#10,$);\n";
    let mut decoder = EntityDecoder::new(content);
    let promoted = Axis2Placement::read_id(2, &mut decoder).unwrap();
    assert_eq!(promoted.location, [1.0, 2.0, 0.0], "INTEGER components read, z = 0 (D26)");
    let tilted = Axis2Placement::read_id(3, &mut decoder).unwrap();
    assert_eq!(tilted.axis, Some([0.0, 1.0, 0.0]));
    assert_eq!(decoder.direction3(10).unwrap()[2], 0.0);
    assert_eq!(decoder.point3(1).unwrap()[2], 0.0);
    assert_eq!(decoder.refused_records(), 0);
}

#[test]
fn a_missing_location_is_refused_and_counted() {
    let content = "#11=IFCDIRECTION((1.,0.,0.));\n#2=IFCAXIS2PLACEMENT3D($,$,#11);\n";
    let mut decoder = EntityDecoder::new(content);
    assert!(matches!(Axis2Placement::read_id(2, &mut decoder), Err(PlacementError::Missing { at: 2, .. })));
    assert_eq!(decoder.refused_records(), 1, "D30: the `$` Location is a counted refusal");
}

/// D25: readable-but-degenerate axes stay repaired, bit for bit, through the
/// canonical readers. Expected values were produced by `build_axis2_matrix`
/// on the base commit (the function is unchanged).
#[test]
fn degenerate_axes_stay_repaired_bit_for_bit() {
    type V = [f64; 3];
    // (Axis, RefDirection, column 0, column 1, column 2)
    let cases: [(V, V, V, V, V); 5] = [
        // zero Axis -> +Z
        ([0.0; 3], [1.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]),
        // zero RefDirection -> +X, then projected
        ([0.0, 0.0, 1.0], [0.0; 3], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]),
        // RefDirection parallel to Axis, vertical Axis
        ([0.0, 0.0, 1.0], [0.0, 0.0, 1.0], [0.0, -1.0, 0.0], [1.0, 0.0, 0.0], [0.0, 0.0, 1.0]),
        // RefDirection parallel to Axis, horizontal Axis
        ([1.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0], [1.0, 0.0, 0.0]),
        // anti-parallel
        ([0.0, 0.0, 1.0], [0.0, 0.0, -1.0], [0.0, -1.0, 0.0], [1.0, 0.0, 0.0], [0.0, 0.0, 1.0]),
    ];
    for (axis, ref_direction, x, y, z) in cases {
        let content = format!(
            "#1=IFCCARTESIANPOINT((1.,2.,3.));\n#10=IFCDIRECTION(({:?},{:?},{:?}));\n#11=IFCDIRECTION(({:?},{:?},{:?}));\n\
             #2=IFCAXIS2PLACEMENT3D(#1,#10,#11);\n",
            axis[0], axis[1], axis[2], ref_direction[0], ref_direction[1], ref_direction[2]
        );
        let mut decoder = EntityDecoder::new(&content);
        let placement = decoder.decode_by_id(2).unwrap();
        let from_reader = Axis2Placement::read_3d(&placement, &mut decoder).unwrap().matrix();
        let by_hand = build_axis2_matrix(Point3::new(1.0, 2.0, 3.0), Vector3::from(axis), Vector3::from(ref_direction));
        assert_eq!(decoder.refused_records(), 0, "{axis:?}/{ref_direction:?}: repaired, not refused");
        for (col, want) in [x, y, z, [1.0, 2.0, 3.0]].into_iter().enumerate() {
            for row in 0..3 {
                assert_eq!(
                    from_reader[(row, col)].to_bits(),
                    by_hand[(row, col)].to_bits(),
                    "{axis:?}/{ref_direction:?}: reader == build_axis2_matrix"
                );
                assert_eq!(from_reader[(row, col)], want[row], "{axis:?}/{ref_direction:?}: ({row},{col})");
            }
        }
    }
}

/// X1 moves `parse_axis2_placement_2d` onto `build_axis2_matrix`. Axis-aligned
/// RefDirections are bit-exact; a rotated one may differ from the old direct
/// assembly by rounding only (X normalised twice, Y once), never more.
#[test]
fn the_2d_placement_is_exact_axis_aligned_and_within_rounding_otherwise() {
    for (ref_direction, exact) in [
        ("(1.,0.)", true),
        ("(0.,1.)", true),
        ("(-1.,0.)", true),
        ("(0.,-1.)", true),
        ("(1.,1.)", false),
        ("(0.6,0.8)", false),
        ("(3.,-4.)", false),
    ] {
        let content = format!("#1=IFCCARTESIANPOINT((4.,5.));\n#2=IFCDIRECTION({ref_direction});\n#3=IFCAXIS2PLACEMENT2D(#1,#2);\n");
        let mut decoder = EntityDecoder::new(&content);
        let placement = decoder.decode_by_id(3).unwrap();
        let m = Axis2Placement::read_2d(&placement, &mut decoder).unwrap().matrix();
        let d = decoder.direction3(2).unwrap();
        let norm = d[0].hypot(d[1]);
        let (cx, cy) = (d[0] / norm, d[1] / norm);
        let tolerance = if exact { 0.0 } else { 4.0 * f64::EPSILON };
        for (got, want) in [(m[(0, 0)], cx), (m[(1, 0)], cy), (m[(0, 1)], -cy), (m[(1, 1)], cx)] {
            assert!((got - want).abs() <= tolerance, "{ref_direction}: {got} vs {want}");
        }
        assert_eq!((m[(0, 3)], m[(1, 3)], m[(2, 3)]), (4.0, 5.0, 0.0));
        assert_eq!(m[(2, 2)], 1.0);
    }
}

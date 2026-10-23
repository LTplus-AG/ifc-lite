// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use super::*;

// A malformed IfcDirection((0,0,0)) as Axis must not NaN-poison the matrix;
// build_axis2_matrix is the only orthonormalisation of a frame.
#[test]
fn build_axis2_matrix_zero_axis_stays_finite() {
    let m = build_axis2_matrix(
        Point3::new(0.0, 0.0, 0.0),
        Vector3::new(0.0, 0.0, 0.0),
        Vector3::new(1.0, 0.0, 0.0),
    );
    assert!(m.iter().all(|v| v.is_finite()), "NaN in matrix: {m:?}");
}

#[test]
fn axis2_placement_reads_raw_attributes_and_defaults_in_matrix() {
    let content = "\
#1=IFCCARTESIANPOINT((10.0,20.0,30.0));
#2=IFCDIRECTION((0.0,1.0,0.0));
#3=IFCAXIS2PLACEMENT3D(#1,#2,$);
#4=IFCAXIS2PLACEMENT3D(#1);
#5=IFCAXIS2PLACEMENT2D(#1,$);
#6=IFCDIRECTION((1.,0.,0.));";
    let mut decoder = EntityDecoder::new(content);
    let placed = Axis2Placement::read_id(3, &mut decoder).unwrap();
    assert_eq!(placed.location, [10.0, 20.0, 30.0]);
    assert_eq!(placed.axis, Some([0.0, 1.0, 0.0]));
    assert_eq!(placed.ref_direction, None);

    // Absent Axis and RefDirection are +Z / +X in the matrix, `None` in the read.
    let bare = Axis2Placement::read_id(4, &mut decoder).unwrap();
    assert_eq!((bare.axis, bare.ref_direction), (None, None));
    let m = bare.matrix();
    assert_eq!(m.column(0).xyz(), Vector3::new(1.0, 0.0, 0.0));
    assert_eq!(m.column(2).xyz(), Vector3::new(0.0, 0.0, 1.0));
    assert_eq!(m.column(3).xyz(), Vector3::new(10.0, 20.0, 30.0));

    // `read` dispatches on the type: a 2D placement is planar, anything else is refused.
    let planar = Axis2Placement::read_id(5, &mut decoder).unwrap();
    assert!(planar.planar && !placed.planar);
    assert_eq!(planar.axis, Some([0.0, 0.0, 1.0]));
    assert!(matches!(
        Axis2Placement::read_id(6, &mut decoder),
        Err(PlacementError::Unsupported { at: 6, found: IfcType::IfcDirection })
    ));
}

#[test]
fn axis2_placement_matrix_is_the_shared_degenerate_repair() {
    // RefDirection parallel to Axis: the repaired frame, not NaN.
    let content = "\
#1=IFCCARTESIANPOINT((0.,0.,0.));
#2=IFCDIRECTION((0.,0.,1.));
#3=IFCAXIS2PLACEMENT3D(#1,#2,#2);";
    let mut decoder = EntityDecoder::new(content);
    let m = Axis2Placement::read_id(3, &mut decoder).unwrap().matrix();
    assert_eq!(m.column(0).xyz(), Vector3::new(0.0, -1.0, 0.0));
}

#[test]
fn axis1_placement_defaults_the_axis_to_plus_z() {
    let content = "\
#1=IFCCARTESIANPOINT((1.,2.,3.));
#2=IFCAXIS1PLACEMENT(#1,$);
#3=IFCDIRECTION((1.,0.,0.));
#4=IFCAXIS1PLACEMENT(#1,#3);";
    let mut decoder = EntityDecoder::new(content);
    let bare = decoder.decode_by_id(2).unwrap();
    let bare = Axis1Placement::read(&bare, &mut decoder).unwrap();
    assert_eq!((bare.location, bare.axis), ([1.0, 2.0, 3.0], None));
    assert_eq!(bare.axis_or_ifc_default(), [0.0, 0.0, 1.0]);
    let tilted = decoder.decode_by_id(4).unwrap();
    assert_eq!(Axis1Placement::read(&tilted, &mut decoder).unwrap().axis_or_ifc_default(), [1.0, 0.0, 0.0]);
    let not_axis1 = decoder.decode_by_id(1).unwrap();
    assert!(Axis1Placement::read(&not_axis1, &mut decoder).is_err());
}

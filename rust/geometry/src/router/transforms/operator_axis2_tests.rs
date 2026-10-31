// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! #8308: an omitted 3D Axis2 is IfcSecondProjAxis' +Y default, projected
//! against Axis3 and Axis1. It is not Axis3 × Axis1. The expected columns are
//! hand-derived from IfcBaseAxis(3, Axis1, Axis2, Axis3).

use super::*;

fn operator(record: &str) -> Matrix4<f64> {
    let content = format!(
        "#1=IFCDIRECTION((-1.,0.,0.));\n#2=IFCDIRECTION((0.,1.,0.));\n#3=IFCDIRECTION((0.,0.,-1.));\n\
         #4=IFCCARTESIANPOINT((0.,0.,0.));\n#5=IFCDIRECTION((1.,0.,0.));\n#6=IFCDIRECTION((0.6,0.8,0.));\n\
         #7=IFCDIRECTION((-0.8,0.6,0.));\n#8=IFCCARTESIANPOINT((0.,0.));\n#9=IFCDIRECTION((-1.,0.));\n\
         #11=IFCDIRECTION((0.,0.,1.));\n#10={record};\n"
    );
    let mut decoder = EntityDecoder::new(&content);
    let entity = decoder.decode_by_id(10).unwrap();
    parse_transformation_operator(&entity, &mut decoder).expect("operator should parse")
}

/// The X, Y, Z columns of the linear part.
fn columns(m: &Matrix4<f64>) -> [[f64; 3]; 3] {
    [0, 1, 2].map(|c| [m[(0, c)], m[(1, c)], m[(2, c)]])
}

fn assert_columns(record: &str, expected: [[f64; 3]; 3], det: f64) {
    let m = operator(record);
    let actual = columns(&m);
    for (a, e) in actual.iter().flatten().zip(expected.iter().flatten()) {
        assert!((a - e).abs() < 1e-12, "{record}: columns {actual:?}, expected {expected:?}");
    }
    assert!((m.determinant() - det).abs() < 1e-12, "{record}: det {}", m.determinant());
}

fn bits(m: &Matrix4<f64>) -> Vec<u64> {
    m.iter().map(|v| v.to_bits()).collect()
}

#[test]
fn omitted_axis2_with_reversed_axis1_is_a_mirror() {
    // D3 = +Z, D1 = -X; +Y is already perpendicular to both, so D2 = +Y.
    // Axis3 × Axis1 would give -Y: a 180° turn about Z instead of the mirror.
    for record in [
        "IFCCARTESIANTRANSFORMATIONOPERATOR3D(#1,$,#4,$,$)",
        // The #8308 reproduction: Scale 1 and Axis3 = +Z authored.
        "IFCCARTESIANTRANSFORMATIONOPERATOR3D(#1,$,#4,1.,#11)",
    ] {
        assert_columns(record, [[-1., 0., 0.], [0., 1., 0.], [0., 0., 1.]], -1.0);
    }
    // Omitting Axis2 and authoring it as +Y are the same operator, bit for bit.
    assert_eq!(
        bits(&operator("IFCCARTESIANTRANSFORMATIONOPERATOR3D(#1,$,#4,$,$)")),
        bits(&operator("IFCCARTESIANTRANSFORMATIONOPERATOR3D(#1,#2,#4,$,$)")),
    );
}

#[test]
fn omitted_axis2_with_reversed_axis3_is_a_mirror() {
    // D3 = -Z, D1 = IfcFirstProjAxis(-Z, $) = +X, D2 = +Y; Axis3 × Axis1 = -Y.
    assert_columns(
        "IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,#4,$,#3)",
        [[1., 0., 0.], [0., 1., 0.], [0., 0., -1.]],
        -1.0,
    );
    // The non-uniform subtype shares the derivation; Scale2 scales the +Y column.
    assert_columns(
        "IFCCARTESIANTRANSFORMATIONOPERATOR3DNONUNIFORM($,$,#4,2.,#3,3.,4.)",
        [[2., 0., 0.], [0., 3., 0.], [0., 0., -4.]],
        -24.0,
    );
}

#[test]
fn omitted_axis2_in_a_right_handed_frame_keeps_the_cross_product_bits() {
    // D1 = (0.6, 0.8, 0): +Y projects onto (-0.8, 0.6, 0) = Axis3 × Axis1, so
    // the frame stays a rotation and keeps the exact cross-product bits.
    let omitted = operator("IFCCARTESIANTRANSFORMATIONOPERATOR3D(#6,$,#4,$,$)");
    let authored = operator("IFCCARTESIANTRANSFORMATIONOPERATOR3D(#6,#7,#4,$,$)");
    assert_eq!(bits(&omitted), bits(&authored));
    assert_columns(
        "IFCCARTESIANTRANSFORMATIONOPERATOR3D(#6,$,#4,$,$)",
        [[0.6, 0.8, 0.], [-0.8, 0.6, 0.], [0., 0., 1.]],
        1.0,
    );
    // The identity operator is untouched.
    assert_eq!(
        bits(&operator("IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,#4,$,$)")),
        bits(&Matrix4::identity()),
    );
}

#[test]
fn omitted_axis2_that_projects_to_nothing_falls_back_to_the_cross_product() {
    // D1 = +Y: the +Y default has no component left, which the schema leaves
    // undefined. Axis3 × Axis1 = -X keeps the frame a finite quarter turn.
    assert_columns(
        "IFCCARTESIANTRANSFORMATIONOPERATOR3D(#2,$,#4,$,$)",
        [[0., 1., 0.], [-1., 0., 0.], [0., 0., 1.]],
        1.0,
    );
    // D3 = +X, D1 = IfcFirstProjAxis(+X, $) = +Y, and +Y collapses again: Y = +Z.
    assert_columns(
        "IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,#4,$,#5)",
        [[0., 1., 0.], [0., 0., 1.], [1., 0., 0.]],
        1.0,
    );
}

#[test]
fn omitted_axis2_of_a_2d_operator_is_the_orthogonal_complement() {
    // IfcBaseAxis 2D: no Axis2 means D2 = IfcOrthogonalComplement(D1). With
    // Axis1 = -X that is -Y, a 180° turn, never the 3D +Y default's mirror.
    assert_columns(
        "IFCCARTESIANTRANSFORMATIONOPERATOR2D(#9,$,#8,$)",
        [[-1., 0., 0.], [0., -1., 0.], [0., 0., 1.]],
        1.0,
    );
}

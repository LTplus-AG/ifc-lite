// SPDX-License-Identifier: MPL-2.0
//! #7955 / #3641: actual SDK diagnostic triangles, not substitute IFC geometry.
//! PC job 488db6fb-fa70-4ee4-8e68-bcb7bfb5277f, source 9779dcd8f5,
//! output SHA256 0ee204f5fbd7d35bde467369bb3371139241b710ffc2d2cb10aaeb628620f5d2.
//! Only the four section candidates were captured (truncated=0); these tests
//! do not claim to replay the full SDK or its volume/source/closure contracts.
#[path = "support/profile_section.rs"]
mod section;
use section::{assert_profile_section, triangle_section};

type Triangle = [[f64; 3]; 3];
const Y: f64 = -0.45+3.8448e-9;
const Z: f64 = -12.816;
const CAPTURED: [Triangle; 4] = [
    [[2.5632000000000004e-8,7.6896e-9,-25.632], [0.53,-0.9,0.0], [0.0,0.0,0.0]],
    [[0.53,-0.9,0.0], [2.5632000000000004e-8,7.6896e-9,-25.632], [0.530000025632,-0.8999999923104001,-25.632]],
    [[3.630000025632,-0.9000000023104,-25.632], [3.63,0.0,0.0], [3.63,-0.90000001,0.0]],
    [[3.63,0.0,0.0], [3.630000025632,-0.9000000023104,-25.632], [3.630000025632,7.689599956783866e-9,-25.632]],
];

fn captured_hits(triangles: &[Triangle]) -> Vec<f64> {
    triangles.iter().flat_map(|&t| triangle_section(t, Y, Z)).collect()
}

#[test]
fn issue_7955_captured_sdk_shared_edge_section() {
    let hits = captured_hits(&CAPTURED);
    // This marker identifies the intended reverse-mutation assertion.
    assert!(hits.iter().any(|&x| (x-(0.265+1.2816e-8)).abs() <= 1e-7),
        "REGION_CAPTURED_SHARED_EDGE: {hits:?}");
    assert_profile_section(&hits);
}

#[test]
fn issue_7955_captured_section_survives_winding_and_diagonal_changes() {
    for triangle in CAPTURED {
        let reference = triangle_section(triangle, Y, Z);
        for order in [[0,1,2],[1,2,0],[2,0,1],[2,1,0],[1,0,2],[0,2,1]] {
            let mut hits = triangle_section(order.map(|i| triangle[i]), Y, Z);
            let mut expected = reference.clone();
            hits.sort_by(f64::total_cmp);
            expected.sort_by(f64::total_cmp);
            hits.dedup();
            expected.dedup();
            assert_eq!(hits, expected, "orientation cannot open a shared-edge crack");
        }
    }
    let [a,b,c] = CAPTURED[0];
    let d = CAPTURED[1][2];
    let [e,f,g] = CAPTURED[2];
    let h = CAPTURED[3][2];
    assert_profile_section(&captured_hits(&[[c,b,d],[c,d,a],[g,f,h],[g,h,e]]));
}

#[test]
#[should_panic(expected = "REGION_SDK_SECTION")]
fn issue_7955_missing_left_face_is_rejected() {
    assert_profile_section(&captured_hits(&CAPTURED[2..]));
}

#[test]
#[should_panic(expected = "REGION_SDK_SECTION")]
fn issue_7955_wrong_left_section_is_rejected() {
    let mut triangles = CAPTURED;
    for triangle in &mut triangles[..2] {
        for p in triangle { p[0] += 0.01; }
    }
    assert_profile_section(&captured_hits(&triangles));
}

#[test]
#[should_panic(expected = "REGION_SDK_SECTION")]
fn issue_7955_missing_right_face_is_rejected() {
    assert_profile_section(&captured_hits(&CAPTURED[..2]));
}

#[test]
fn issue_7955_closed_edge_vertex_and_coplanar_controls() {
    // Closed triangle: the line touches only a vertex.
    let hits = triangle_section([[2.,0.,0.],[4.,1.,1.],[0.,1.,1.]],0.,0.);
    assert!(!hits.is_empty() && hits.iter().all(|&x| x == 2.));
    // Section coincides with an edge. Duplicate hits cannot change extrema.
    let hits = triangle_section([[2.,0.,0.],[4.,0.,0.],[3.,1.,1.]],0.,0.);
    assert_eq!(hits.iter().copied().fold(f64::INFINITY,f64::min),2.);
    assert_eq!(hits.iter().copied().fold(f64::NEG_INFINITY,f64::max),4.);
    // Entire triangle lies on the Z plane; its Y cut is a real segment.
    let hits = triangle_section([[0.,0.,0.],[4.,0.,0.],[0.,4.,0.]],1.,0.);
    assert_eq!(hits.iter().copied().fold(f64::INFINITY,f64::min),0.);
    assert_eq!(hits.iter().copied().fold(f64::NEG_INFINITY,f64::max),3.);
    // A one-ULP outside query must remain outside: no geometric epsilon.
    let below = -f64::from_bits(1);
    assert!(triangle_section([[0.,0.,0.],[4.,0.,0.],[0.,4.,0.]],below,0.).is_empty());
    assert!(triangle_section([[0.,0.,0.],[4.,0.,0.],[0.,4.,0.]],1.,below).is_empty());
}

#[test]
fn issue_7955_captured_slice_agrees_with_independent_projected_solve() {
    use num_rational::BigRational;
    use num_traits::{ToPrimitive, Zero};
    // Cramer's rule on the YZ projection solves the line/triangle problem
    // directly. It does not reuse the edge clipping or the expected section.
    for triangle in CAPTURED {
        let [a,b,c] = triangle.map(|p| p.map(|v| BigRational::from_float(v).unwrap()));
        let u: [_; 3] = std::array::from_fn(|i| &b[i]-&a[i]);
        let v: [_; 3] = std::array::from_fn(|i| &c[i]-&a[i]);
        let dy = BigRational::from_float(Y).unwrap()-&a[1];
        let dz = BigRational::from_float(Z).unwrap()-&a[2];
        let det = &u[1]*&v[2]-&u[2]*&v[1];
        assert!(!det.is_zero(), "captured face has a nonsingular YZ projection");
        let s = (&dy*&v[2]-&dz*&v[1])/&det;
        let t = (&u[1]*&dz-&u[2]*&dy)/&det;
        let mut hits = triangle_section(triangle,Y,Z);
        hits.sort_by(f64::total_cmp);
        hits.dedup();
        if s >= BigRational::zero() && t >= BigRational::zero()
            && &s+&t <= BigRational::from_integer(1.into()) {
            let x = (&a[0]+&s*&u[0]+&t*&v[0]).to_f64().unwrap();
            assert_eq!(hits, vec![x]);
        } else {
            assert!(hits.is_empty());
        }
    }
}

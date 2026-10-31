// SPDX-License-Identifier: MPL-2.0
#![cfg(feature = "retained-runtime")]
//! #8291: the arithmetic a cut's new corner gets its authored UV from, with no kernel.
#[allow(dead_code)]
#[path = "../src/element/session_retained/presentation/surface_rows.rs"]
mod rows;
use rows::{barycentric, row_of};

#[test]
fn issue_8291_barycentric_reproduces_the_affine_uv_map_at_a_new_cut_vertex() {
    let triangle = [[0., 0., 0.], [2., 0., 0.], [0., 4., 0.]];
    let uv = |p: [f64; 3]| [0.25 + p[0] / 2., 0.5 - p[1] / 8.];
    let (a, b, c) = (uv(triangle[0]), uv(triangle[1]), uv(triangle[2]));
    let cut = [0.75, 1.25, 0.];
    let w = barycentric(cut, &triangle).unwrap();
    for axis in 0..2 {
        let interpolated = w[0] * a[axis] + w[1] * b[axis] + w[2] * c[axis];
        assert!((interpolated - uv(cut)[axis]).abs() < 1e-15);
    }
    assert!(barycentric(cut, &[[0.; 3], [1., 0., 0.], [2., 0., 0.]]).is_none(), "a degenerate row has no map");
}

#[test]
fn issue_8291_only_row_roles_name_rows() {
    assert_eq!(row_of("row(12)"), Some(12));
    assert_eq!(row_of("row(3);band(1)"), Some(3));
    assert_eq!(row_of("cap(start)"), None);
    assert_eq!(row_of("side(0,1)"), None);
}

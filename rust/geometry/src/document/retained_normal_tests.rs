// SPDX-License-Identifier: MPL-2.0
// #7955: independent unit-cylinder gradients survive the display boundary.
use super::retained_display::display_mesh;
use super::RetainedTessellation;

fn cylinder() -> RetainedTessellation {
    let (s, c) = 0.3_f64.sin_cos();
    RetainedTessellation {
        positions: vec![1., 0., 0., c, s, 0., 1., 0., 1.],
        indices: vec![0, 1, 2],
        flat_corner_normals: vec![1., 0., 0., c, s, 0., 1., 0., 0.],
        revision_local_faces: vec![0],
        source_face_count: 1,
        boundary_edges: 0,
        spine_edges: 0,
    }
}

#[test]
fn j5_cylinder_gradients_survive_corner_expansion() {
    let data = cylinder();
    let mesh = display_mesh(&data).unwrap();
    for (i, n) in mesh.normals.chunks_exact(3).enumerate() {
        // Gradient of x²+y²=1, independent of triangle cross products.
        assert!((f64::from(n[0]) - data.positions[i*3]).abs() < 1e-7);
        assert!((f64::from(n[1]) - data.positions[i*3+1]).abs() < 1e-7);
        assert_eq!(n[2], 0.);
    }
    assert_ne!(&mesh.normals[..3], &mesh.normals[3..6]);
    assert_eq!(mesh.indices, data.indices);
}

#[test]
fn j5_incomplete_nonfinite_zero_nonunit_and_inward_normals_refuse() {
    for bad in [vec![], vec![0.; 9], vec![f64::NAN; 9], vec![f64::INFINITY; 9], vec![2.; 9]] {
        let mut data = cylinder();
        data.flat_corner_normals = bad;
        assert!(display_mesh(&data).is_err());
    }
    let mut data = cylinder();
    data.flat_corner_normals[0] = -1.;
    assert!(display_mesh(&data).is_err());
    let mut data = cylinder();
    data.indices.swap(1, 2);
    assert!(display_mesh(&data).is_err(), "no winding repair may flatten source normals");
}

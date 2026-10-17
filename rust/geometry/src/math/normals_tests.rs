// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! GEOM-11 / D23 (#7772, X1): one normal-transform policy at all three sites
//! (the router's flat bake, the generic sink, the orphan don't-bake bake).
//! A singular transform or a zero result writes ZERO normals, never NaN and
//! never a `Mᵀ`-skewed vector; a regular transform is the 4x4
//! inverse-transpose then a divide by the norm, bit for bit.

use crate::instancing::bake_source_at_world;
use crate::router::GeometryRouter;
use crate::scalar::MeshSink;
use crate::Mesh;
use nalgebra::{Matrix4, Vector3};

const NORMALS: [f32; 12] = [1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 1.0, 0.0, 0.6, 0.0, 0.8];

fn triangle() -> Mesh {
    let mut mesh = Mesh::new();
    mesh.positions = vec![0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0];
    mesh.normals = NORMALS.to_vec();
    mesh.indices = vec![0, 1, 2, 0, 2, 3];
    mesh
}

/// Zero scale on Z (the zero-scale `IfcCartesianTransformationOperator` case).
fn singular() -> Matrix4<f64> {
    Matrix4::new_translation(&Vector3::new(3.0, 4.0, 5.0))
        * Matrix4::new_nonuniform_scaling(&Vector3::new(1.0, 1.0, 0.0))
}

/// Rotated, non-uniformly scaled, translated, regular.
fn regular() -> Matrix4<f64> {
    Matrix4::new_translation(&Vector3::new(3.0, 4.0, 5.0))
        * Matrix4::from_euler_angles(0.3, -0.7, 1.1)
        * Matrix4::new_nonuniform_scaling(&Vector3::new(2.0, 0.5, 3.0))
}

/// The flat bake's numerics, written out: 4x4 inverse, transpose, divide.
fn reference(m: &Matrix4<f64>) -> Vec<f32> {
    let nm = m.try_inverse().expect("regular").transpose();
    let mut out = Vec::new();
    for c in NORMALS.chunks_exact(3) {
        let n = Vector3::new(c[0] as f64, c[1] as f64, c[2] as f64);
        let t = (nm * n.to_homogeneous()).xyz().normalize();
        out.extend([t.x as f32, t.y as f32, t.z as f32]);
    }
    out
}

fn flat_router(m: &Matrix4<f64>) -> Vec<f32> {
    let mut mesh = triangle();
    GeometryRouter::new().transform_mesh_world_framed(&mut mesh, m, false);
    mesh.normals
}

fn generic_sink(m: &Matrix4<f64>) -> Vec<f32> {
    let mut mesh = triangle();
    MeshSink::<f64>::transform_normals(&mut mesh, m);
    mesh.normals
}

fn orphan_bake(m: &Matrix4<f64>) -> Vec<f32> {
    let mut rm = [0.0f64; 16];
    for r in 0..4 {
        for c in 0..4 {
            rm[r * 4 + c] = m[(r, c)];
        }
    }
    bake_source_at_world(&triangle(), &rm, [0.0; 3]).1
}

fn bits(v: &[f32]) -> Vec<u32> {
    v.iter().map(|x| x.to_bits()).collect()
}

#[test]
fn issue_7772_x1_singular_transform_gives_zero_normals_never_nan() {
    let m = singular();
    assert!(m.try_inverse().is_none(), "fixture must be singular");
    for (site, got) in [
        ("router flat bake", flat_router(&m)),
        ("generic sink", generic_sink(&m)),
        ("orphan don't-bake", orphan_bake(&m)),
    ] {
        assert!(
            got.iter().all(|v| *v == 0.0),
            "{site}: a singular transform must write zero normals, got {got:?}"
        );
    }
}

#[test]
fn issue_7772_x1_zero_input_normal_stays_zero_not_nan() {
    let m = regular();
    let mut mesh = triangle();
    mesh.normals = vec![0.0; 12];
    GeometryRouter::new().transform_mesh_world_framed(&mut mesh, &m, false);
    assert!(mesh.normals.iter().all(|v| *v == 0.0), "{:?}", mesh.normals);
}

#[test]
fn issue_7772_x1_regular_transform_is_one_bit_exact_policy_at_every_site() {
    let m = regular();
    let want = bits(&reference(&m));
    assert_eq!(bits(&flat_router(&m)), want, "router flat bake");
    assert_eq!(bits(&generic_sink(&m)), want, "generic sink");
    assert_eq!(bits(&orphan_bake(&m)), want, "orphan don't-bake");
}

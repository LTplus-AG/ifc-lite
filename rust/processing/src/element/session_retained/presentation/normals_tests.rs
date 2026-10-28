// SPDX-License-Identifier: MPL-2.0
#![cfg(feature = "retained-runtime")]
use super::*;
use ifc_lite_geometry::resource::{BudgetStart, ProductBudget};

fn part(positions: Vec<f64>, indices: Vec<u32>, faces: Vec<u32>) -> ShapePart {
    ShapePart { positions, indices, revision_local_faces: faces,
        world_from_object: [1.,0.,0.,0., 0.,1.,0.,0., 0.,0.,1.,0., 0.,0.,0.,1.],
        curved: true, normals: None, appearance: None, faces: None, instance_key: None }
}
fn normals(p: &ShapePart) -> Vec<f64> {
    corner_normals(p, &OwnedResourceContext::capture_current(), &mut Storage::default()).unwrap()
}
fn near(actual: &[f64], expected: [f64; 3]) {
    for (a, b) in actual.iter().zip(expected) { assert!((a - b).abs() < 1e-12, "{actual:?} != {expected:?}"); }
}
fn fan(tilts: &[f64], angles: &[f64]) -> ShapePart {
    let mut positions = vec![0.,0.,0., 1.,0.,0.];
    let mut indices = Vec::new();
    for (i, (&tilt, &angle)) in tilts.iter().zip(angles).enumerate() {
        let (t, a) = (tilt.to_radians(), angle.to_radians());
        positions.extend([a.cos(), a.sin()*t.cos(), a.sin()*t.sin()]);
        indices.extend([0, 1, i as u32 + 2]);
    }
    part(positions, indices, vec![77; tilts.len()])
}

#[test]
fn m11_n_7955_cube_has_six_exact_normals_and_unchanged_topology() {
    let p = part(vec![0.,0.,0., 1.,0.,0., 1.,1.,0., 0.,1.,0.,
        0.,0.,1., 1.,0.,1., 1.,1.,1., 0.,1.,1.],
        vec![0,2,1, 0,3,2, 4,5,6, 4,6,7, 0,1,5, 0,5,4,
             1,2,6, 1,6,5, 2,3,7, 2,7,6, 3,0,4, 3,4,7],
        vec![10,10,20,20,30,30,40,40,50,50,60,60]);
    let (positions, indices, faces) = (p.positions.clone(), p.indices.clone(), p.revision_local_faces.clone());
    let result = normals(&p);
    let planes = [[0.,0.,-1.], [0.,0.,1.], [0.,-1.,0.], [1.,0.,0.], [0.,1.,0.], [-1.,0.,0.]];
    for (side, plane) in result.chunks_exact(18).zip(planes) {
        for n in side.chunks_exact(3) { near(n, plane); }
    }
    assert_eq!((p.positions, p.indices, p.revision_local_faces), (positions, indices, faces));
}

#[test]
fn m11_n_7955_crease_guard_is_relative_to_each_own_facet_not_transitive() {
    let p = fan(&[0., 8., 16., 30.], &[90.; 4]);
    let result = normals(&p);
    // 0 includes 8 but excludes 16; 8 includes 0 and 16; 30 is isolated.
    for (corner, degrees) in [(0,4_f64), (3,8.), (6,12.), (9,30.)] {
        let t = degrees.to_radians();
        near(&result[corner*3..corner*3+3], [0., -t.sin(), t.cos()]);
    }
}

#[test]
fn m11_n_7955_angle_weights_and_revision_local_face_boundaries() {
    let mut p = fan(&[0., 8.], &[30.,90.]);
    let result = normals(&p);
    let t = 8_f64.to_radians();
    let expected = [0., -3.*t.sin(), 1.+3.*t.cos()];
    let l = expected.iter().map(|v| v*v).sum::<f64>().sqrt();
    near(&result[..3], expected.map(|v| v/l));
    p.revision_local_faces[1] = 78;
    let result = normals(&p);
    near(&result[..3], [0.,0.,1.]);
    near(&result[9..12], [0.,-t.sin(),t.cos()]);
}

fn prism(n: u32) -> ShapePart {
    let mut positions = Vec::new();
    for z in [0., 2.] {
        for i in 0..n { let a = f64::from(i) * std::f64::consts::TAU / f64::from(n); positions.extend([a.cos(),a.sin(),z]); }
    }
    let mut indices = Vec::new();
    let mut faces = Vec::new();
    for i in 0..n { let j = (i+1)%n; indices.extend([i,j,j+n, i,j+n,i+n]); faces.extend([4,4]); }
    for i in 1..n-1 { indices.extend([0,i+1,i, n,n+i,n+i+1]); faces.extend([1,2]); }
    part(positions, indices, faces)
}

#[test]
fn m11_n_7955_fine_prism_smooths_radially_but_caps_stay_creased() {
    let p = prism(72);
    let result = normals(&p);
    for (corner, normal) in result.chunks_exact(3).enumerate() {
        let face = p.revision_local_faces[corner/3];
        let i = p.indices[corner] as usize * 3;
        let expected = match face { 1 => [0.,0.,-1.], 2 => [0.,0.,1.], _ => [p.positions[i],p.positions[i+1],0.] };
        near(normal, expected);
    }
}

#[test]
fn m11_n_7955_sixteen_gon_exceeds_ten_degree_crease_guard() {
    // 22.5 degree dihedrals exceed the normative guard, even on a single face.
    let p = prism(16);
    let result = normals(&p);
    for i in 0..16 { let a = (i as f64 + 0.5) * std::f64::consts::TAU / 16.;
        for normal in result[i*18..i*18+18].chunks_exact(3) { near(normal, [a.cos(),a.sin(),0.]); }
    }
}

#[test]
fn m11_n_7955_frame_scale_mirror_and_large_translation_precede_normals() {
    let mut p = fan(&[30.], &[90.]);
    p.world_from_object = [-2.,0.,0.,0., 0.,3.,0.,0., 0.,0.,4.,0., 2.6e6,-1e20,7e15,1.];
    // Transformed cross product: (0, 4*sin(30), -3*cos(30)).
    let expected = [0.,2.,-3.*30_f64.to_radians().cos()];
    let l = expected.iter().map(|v| v*v).sum::<f64>().sqrt();
    for normal in normals(&p).chunks_exact(3) { near(normal, expected.map(|v| v/l)); }
}

#[test]
fn m11_n_7955_invalid_and_degenerate_meshes_refuse_without_nan_normals() {
    let mut p = fan(&[0.], &[90.]);
    for fault in 0..4 {
        match fault { 0 => p.revision_local_faces.clear(), 1 => {p.revision_local_faces.push(77); p.indices[0]=99;},
            2 => p.indices[0]=1, _ => {p.indices[0]=0; p.positions[0]=f64::NAN;} }
        assert_eq!(corner_normals(&p, &OwnedResourceContext::capture_current(), &mut Storage::default())
            .unwrap_err().refusal().0.code(), "contract_breach");
    }
}

#[test]
fn m11_n_7955_budget_bounds_backing_and_high_valence_work() {
    for (work, bytes) in [(1_000_000, 1), (100, 1_000_000)] {
        let budget = ProductBudget::new(BudgetStart::now(), work, bytes, 10000);
        budget.scope(|| {
            let p = fan(&[0.; 100], &[90.; 100]);
            assert_eq!(corner_normals(&p, &OwnedResourceContext::capture_current(), &mut Storage::default())
                .unwrap_err().refusal().0.code(), "resource_exhausted");
        });
    }
}
